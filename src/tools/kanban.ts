/**
 * Kanban Tool
 * Manage a project's Kanban board: views, buckets (columns), task placement.
 *
 * Buckets belong to a project's Kanban *view*, so every op needs a viewId. It is
 * auto-resolved to the project's `view_kind === 'kanban'` view when not given, so
 * callers work in terms of project + column name, not opaque view/bucket ids.
 *
 * Safety invariants (a board must never be left in an unintended state):
 * - Deleting a bucket first relocates its tasks to a live bucket; if any task
 *   can't be moved, the delete is aborted (preserve data over partial success).
 * - Bulk/relocation moves run sequentially, retry once, and are verified by
 *   re-reading the board — silent partial moves are reported as failures.
 * - Destructive ops (`delete-bucket`, `apply-template` with removeExtra) accept
 *   `dryRun` to preview exactly what will change before committing.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { TaskService } from 'node-vikunja';
import type { AuthManager } from '../auth/AuthManager';
import type { VikunjaClientFactory } from '../client/VikunjaClientFactory';
import { MCPError, ErrorCode } from '../types';
import { getClientFromContext, setGlobalClientFactory } from '../client';
import { createAuthRequiredError } from '../utils/error-handler';
import {
  getProjectViews,
  getViewBuckets,
  getBucketsForView,
  createBucket,
  updateBucket,
  deleteBucket,
  updateView,
  moveTaskToBucket,
  updateTaskPosition,
  type TaskBucket,
  type ProjectViewLite,
  type BucketInput,
} from '../client/applyTaskServiceCompatibility';

/** Vikunja orders buckets by a float `position`; this is its native step. */
const POSITION_STEP = 65536;

interface MoveOutcome {
  moved: number[];
  failed: Array<{ id: number; reason: string }>;
}

function text(content: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text' as const, text: content }] };
}

/** Build a BucketInput including only the defined fields (exactOptionalPropertyTypes). */
function bucketInput(fields: {
  title?: string | undefined;
  position?: number | undefined;
  limit?: number | undefined;
}): BucketInput {
  const out: BucketInput = {};
  if (fields.title !== undefined) out.title = fields.title;
  if (fields.position !== undefined) out.position = fields.position;
  if (fields.limit !== undefined) out.limit = fields.limit;
  return out;
}

async function resolveKanbanViewId(service: TaskService, projectId: number): Promise<number> {
  const views = (await getProjectViews(service, projectId)) ?? [];
  const kanban = views.find((v) => v.view_kind === 'kanban');
  if (!kanban) {
    throw new MCPError(ErrorCode.NOT_FOUND, `Project ${projectId} has no Kanban view`);
  }
  return kanban.id;
}

async function resolveView(service: TaskService, projectId: number, viewId: number): Promise<ProjectViewLite> {
  const views = (await getProjectViews(service, projectId)) ?? [];
  const view = views.find((v) => v.id === viewId);
  if (!view) {
    throw new MCPError(ErrorCode.NOT_FOUND, `View ${viewId} not found in project ${projectId}`);
  }
  return view;
}

async function orderedBuckets(service: TaskService, projectId: number, viewId: number): Promise<TaskBucket[]> {
  const buckets = (await getViewBuckets(service, projectId, viewId)) ?? [];
  return [...buckets].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

/** Buckets with their tasks (board endpoint) — the source of truth for placement. */
async function bucketsWithTasks(service: TaskService, projectId: number, viewId: number): Promise<TaskBucket[]> {
  return (await getBucketsForView(service, projectId, viewId)) ?? [];
}

/** Map of taskId -> bucketId for a view, from the board's tasks-by-bucket endpoint. */
function taskBucketMapFrom(buckets: TaskBucket[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const bucket of buckets) {
    for (const task of bucket.tasks ?? []) {
      if (task.id !== undefined) {
        map.set(task.id, bucket.id);
      }
    }
  }
  return map;
}

function taskIdsOf(bucket: TaskBucket | undefined): number[] {
  return (bucket?.tasks ?? []).map((t) => t.id).filter((id): id is number => id !== undefined);
}

/**
 * Move tasks into a bucket one at a time (retry once each), then re-read the
 * board and confirm each actually landed — so a silent partial move surfaces as
 * a failure rather than corrupting the board.
 */
async function moveTasks(
  service: TaskService,
  projectId: number,
  viewId: number,
  taskIds: number[],
  destBucketId: number,
): Promise<MoveOutcome> {
  const moved: number[] = [];
  const failed: Array<{ id: number; reason: string }> = [];

  for (const id of taskIds) {
    let lastError: unknown;
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      try {
        await moveTaskToBucket(service, projectId, viewId, destBucketId, id);
        ok = true;
      } catch (error) {
        lastError = error;
      }
    }
    if (ok) {
      moved.push(id);
    } else {
      failed.push({ id, reason: lastError instanceof Error ? lastError.message : String(lastError) });
    }
  }

  // Post-condition check: confirm the moves actually took.
  try {
    const map = taskBucketMapFrom(await bucketsWithTasks(service, projectId, viewId));
    for (const id of [...moved]) {
      if (map.get(id) !== destBucketId) {
        moved.splice(moved.indexOf(id), 1);
        failed.push({ id, reason: `move reported success but task is in bucket ${map.get(id) ?? 'none'}` });
      }
    }
  } catch {
    // verification best-effort; keep the optimistic result
  }

  return { moved, failed };
}

/**
 * Delete a bucket without orphaning its tasks: relocate them to a live bucket
 * first (the given destination, else the view default, else any other bucket),
 * aborting if any task can't be moved. Fixes view default/done refs if they
 * pointed at the deleted bucket.
 */
async function deleteBucketSafely(
  service: TaskService,
  projectId: number,
  viewId: number,
  bucketId: number,
  view: ProjectViewLite,
  buckets: TaskBucket[],
  intoBucketId?: number,
): Promise<{ movedTasks: number[]; destination?: number }> {
  const liveIds = buckets.map((b) => b.id);
  const target = buckets.find((b) => b.id === bucketId);
  if (!target) {
    throw new MCPError(ErrorCode.NOT_FOUND, `Bucket ${bucketId} not found in view ${viewId}`);
  }
  const taskIds = taskIdsOf(target);

  let destination = intoBucketId ?? view.default_bucket_id;
  if (destination === undefined || destination === 0 || destination === bucketId || !liveIds.includes(destination)) {
    destination = liveIds.find((id) => id !== bucketId);
  }

  if (taskIds.length > 0) {
    if (destination === undefined) {
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        `Cannot delete bucket ${bucketId}: it holds ${taskIds.length} task(s) and there is no other column to move them to. Nothing was deleted.`,
      );
    }
    const result = await moveTasks(service, projectId, viewId, taskIds, destination);
    if (result.failed.length > 0) {
      throw new MCPError(
        ErrorCode.INTERNAL_ERROR,
        `Aborted delete of bucket ${bucketId}: could not relocate ${result.failed.length} task(s) ` +
          `(${result.failed.map((f) => f.id).join(', ')}). Nothing was deleted, no tasks orphaned.`,
      );
    }
  }

  await deleteBucket(service, projectId, viewId, bucketId);

  const patch: Partial<ProjectViewLite> = {};
  if (view.default_bucket_id === bucketId) patch.default_bucket_id = destination ?? 0;
  if (view.done_bucket_id === bucketId) patch.done_bucket_id = 0;
  if (Object.keys(patch).length > 0) {
    await updateView(service, projectId, viewId, { ...view, ...patch });
  }

  const out: { movedTasks: number[]; destination?: number } = {
    movedTasks: taskIds.length > 0 ? taskIds : [],
  };
  if (destination !== undefined) {
    out.destination = destination;
  }
  return out;
}

function formatBucketTable(buckets: TaskBucket[], view: ProjectViewLite, counts: Map<number, number>): string {
  const rows = buckets.map((b) => {
    const flags = [
      b.id === view.default_bucket_id ? 'default' : '',
      b.id === view.done_bucket_id ? 'done' : '',
    ].filter(Boolean).join(', ');
    const count = counts.get(b.id);
    const limit = b.limit && b.limit > 0 ? String(b.limit) : '';
    return `| ${b.id} | ${b.title ?? ''} | ${count ?? ''} | ${limit} | ${flags} |`;
  });
  return [
    '| Bucket ID | Column | Tasks | Limit | Role |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

export function registerKanbanTool(
  server: McpServer,
  authManager: AuthManager,
  clientFactory?: VikunjaClientFactory,
): void {
  server.tool(
    'vikunja_kanban',
    'Manage a project Kanban board: list views, list/create/update/delete columns (buckets), ' +
      'move tasks between columns, set the default/done column, and apply a column template. ' +
      'viewId auto-resolves to the project Kanban view when omitted. Destructive ops relocate ' +
      'tasks before deleting and accept dryRun to preview.',
    {
      operation: z.enum([
        'list-views',
        'list-buckets',
        'create-bucket',
        'update-bucket',
        'delete-bucket',
        'move-task',
        'bulk-move',
        'set-task-position',
        'set-view-config',
        'apply-template',
      ]),
      projectId: z.number().int().positive(),
      viewId: z.number().int().positive().optional(),
      bucketId: z.number().int().positive().optional(),
      intoBucketId: z.number().int().positive().optional(),
      taskId: z.number().int().positive().optional(),
      taskIds: z.array(z.number().int().positive()).optional(),
      title: z.string().min(1).optional(),
      position: z.number().optional(),
      limit: z.number().int().min(0).optional(),
      defaultBucketId: z.number().int().positive().optional(),
      doneBucketId: z.number().int().positive().optional(),
      columns: z.array(z.string().min(1)).optional(),
      doneColumn: z.string().optional(),
      defaultColumn: z.string().optional(),
      removeExtra: z.boolean().optional(),
      dryRun: z.boolean().optional(),
    },
    async (args) => {
      if (!authManager.isAuthenticated()) {
        throw createAuthRequiredError('manage Kanban boards');
      }
      if (clientFactory) {
        await setGlobalClientFactory(clientFactory);
      }
      const client = await getClientFromContext();
      const service = client.tasks;
      const projectId = args.projectId;

      try {
        switch (args.operation) {
          case 'list-views': {
            const views = (await getProjectViews(service, projectId)) ?? [];
            const rows = views.map((v) => `| ${v.id} | ${v.title} | ${v.view_kind} |`).join('\n');
            return text(
              `## Views for project ${projectId}\n\n| View ID | Title | Kind |\n| --- | --- | --- |\n${rows}\n`,
            );
          }

          case 'list-buckets': {
            const viewId = args.viewId ?? (await resolveKanbanViewId(service, projectId));
            const [view, buckets, withTasks] = await Promise.all([
              resolveView(service, projectId, viewId),
              orderedBuckets(service, projectId, viewId),
              bucketsWithTasks(service, projectId, viewId),
            ]);
            const counts = new Map(withTasks.map((b) => [b.id, taskIdsOf(b).length]));
            return text(
              `## Kanban columns — project ${projectId}, view ${viewId}\n\n${formatBucketTable(buckets, view, counts)}\n`,
            );
          }

          case 'create-bucket': {
            if (!args.title) {
              throw new MCPError(ErrorCode.VALIDATION_ERROR, 'title is required to create a bucket');
            }
            const viewId = args.viewId ?? (await resolveKanbanViewId(service, projectId));
            const created = await createBucket(
              service,
              projectId,
              viewId,
              bucketInput({ title: args.title, position: args.position, limit: args.limit }),
            );
            return text(`Created column "${args.title}" (bucket ${created.id}) in project ${projectId}, view ${viewId}`);
          }

          case 'update-bucket': {
            if (args.bucketId === undefined) {
              throw new MCPError(ErrorCode.VALIDATION_ERROR, 'bucketId is required to update a bucket');
            }
            const viewId = args.viewId ?? (await resolveKanbanViewId(service, projectId));
            const existing = (await getViewBuckets(service, projectId, viewId)) ?? [];
            const current = existing.find((b) => b.id === args.bucketId);
            if (!current) {
              throw new MCPError(ErrorCode.NOT_FOUND, `Bucket ${args.bucketId} not found in view ${viewId}`);
            }
            const merged = bucketInput({
              title: args.title ?? current.title,
              position: args.position ?? current.position,
              limit: args.limit ?? current.limit,
            });
            await updateBucket(service, projectId, viewId, args.bucketId, merged);
            return text(`Updated column ${args.bucketId} in project ${projectId} → ${JSON.stringify(merged)}`);
          }

          case 'delete-bucket': {
            if (args.bucketId === undefined) {
              throw new MCPError(ErrorCode.VALIDATION_ERROR, 'bucketId is required to delete a bucket');
            }
            const viewId = args.viewId ?? (await resolveKanbanViewId(service, projectId));
            const [view, withTasks] = await Promise.all([
              resolveView(service, projectId, viewId),
              bucketsWithTasks(service, projectId, viewId),
            ]);
            const target = withTasks.find((b) => b.id === args.bucketId);
            if (!target) {
              throw new MCPError(ErrorCode.NOT_FOUND, `Bucket ${args.bucketId} not found in view ${viewId}`);
            }
            const taskIds = taskIdsOf(target);
            const liveIds = withTasks.map((b) => b.id);
            let dest = args.intoBucketId ?? view.default_bucket_id;
            if (dest === undefined || dest === 0 || dest === args.bucketId || !liveIds.includes(dest)) {
              dest = liveIds.find((id) => id !== args.bucketId);
            }

            if (args.dryRun) {
              return text(
                `## Dry run — delete column "${target.title}" (${args.bucketId})\n\n` +
                  `- ${taskIds.length} task(s) would move to bucket ${dest ?? '(none available — delete would be refused)'}\n` +
                  (view.default_bucket_id === args.bucketId ? `- view default column would become ${dest ?? 0}\n` : '') +
                  (view.done_bucket_id === args.bucketId ? `- view done column would be unset\n` : ''),
              );
            }

            const result = await deleteBucketSafely(service, projectId, viewId, args.bucketId, view, withTasks, args.intoBucketId);
            return text(
              `Deleted column "${target.title}" (${args.bucketId})` +
                (result.movedTasks.length > 0 ? `; relocated ${result.movedTasks.length} task(s) to bucket ${result.destination}` : ''),
            );
          }

          case 'move-task': {
            // `intoBucketId` is accepted as an alias for `bucketId` so callers
            // that use the delete-bucket relocation key don't silently fail here.
            const destBucketId = args.bucketId ?? args.intoBucketId;
            if (args.taskId === undefined || destBucketId === undefined) {
              throw new MCPError(ErrorCode.VALIDATION_ERROR, 'taskId and bucketId (or intoBucketId) are required to move a task');
            }
            const viewId = args.viewId ?? (await resolveKanbanViewId(service, projectId));
            const result = await moveTasks(service, projectId, viewId, [args.taskId], destBucketId);
            if (result.failed.length > 0) {
              throw new MCPError(ErrorCode.INTERNAL_ERROR, `Move failed: task ${args.taskId} — ${result.failed[0]?.reason}`);
            }
            return text(`Moved task ${args.taskId} to column ${destBucketId} (verified)`);
          }

          case 'bulk-move': {
            const destBucketId = args.bucketId ?? args.intoBucketId;
            if (!args.taskIds || args.taskIds.length === 0 || destBucketId === undefined) {
              throw new MCPError(ErrorCode.VALIDATION_ERROR, 'taskIds and bucketId (or intoBucketId) are required for bulk-move');
            }
            const viewId = args.viewId ?? (await resolveKanbanViewId(service, projectId));
            const result = await moveTasks(service, projectId, viewId, args.taskIds, destBucketId);
            const summary =
              `Moved ${result.moved.length}/${args.taskIds.length} task(s) to column ${destBucketId} (verified).`;
            const failReport =
              result.failed.length > 0
                ? `\n\nFailed (${result.failed.length}):\n` +
                  result.failed.map((f) => `- task ${f.id}: ${f.reason}`).join('\n')
                : '';
            return text(summary + failReport);
          }

          case 'set-task-position': {
            // Orders a task WITHIN its column. Position is a float and is stored per
            // view — lower sorts higher. To drop a task between two neighbours, read
            // their positions (list-buckets returns tasks in order) and pass the
            // midpoint. Vikunja recalculates the whole view if positions get too close.
            if (args.taskId === undefined || args.position === undefined) {
              throw new MCPError(
                ErrorCode.VALIDATION_ERROR,
                'taskId and position are required to set a task position',
              );
            }
            const viewId = args.viewId ?? (await resolveKanbanViewId(service, projectId));
            await updateTaskPosition(service, args.taskId, viewId, args.position);
            return text(`Set task ${args.taskId} to position ${args.position} in view ${viewId}`);
          }

          case 'set-view-config': {
            const viewId = args.viewId ?? (await resolveKanbanViewId(service, projectId));
            const view = await resolveView(service, projectId, viewId);
            const updated: ProjectViewLite = {
              ...view,
              ...(args.defaultBucketId !== undefined && { default_bucket_id: args.defaultBucketId }),
              ...(args.doneBucketId !== undefined && { done_bucket_id: args.doneBucketId }),
            };
            await updateView(service, projectId, viewId, updated);
            return text(
              `Set view ${viewId} config — default bucket ${updated.default_bucket_id}, done bucket ${updated.done_bucket_id}`,
            );
          }

          case 'apply-template': {
            if (!args.columns || args.columns.length === 0) {
              throw new MCPError(ErrorCode.VALIDATION_ERROR, 'columns (ordered list) is required for apply-template');
            }
            const columns = args.columns;
            const viewId = args.viewId ?? (await resolveKanbanViewId(service, projectId));
            const view = await resolveView(service, projectId, viewId);
            const existing = await bucketsWithTasks(service, projectId, viewId);
            const existingByTitle = new Map(existing.map((b) => [b.title ?? '', b]));
            const extras = existing.filter((b) => !columns.includes(b.title ?? ''));

            if (args.dryRun) {
              const plan = columns.map((title, i) =>
                existingByTitle.has(title) ? `reorder "${title}" → #${i + 1}` : `create "${title}" → #${i + 1}`,
              );
              const extraPlan = args.removeExtra
                ? extras.map((e) => `delete "${e.title}" (moving ${taskIdsOf(e).length} task(s) to the default column)`)
                : extras.map((e) => `keep "${e.title}" (${taskIdsOf(e).length} task(s)) — pass removeExtra to delete`);
              return text(
                `## Dry run — apply template to project ${projectId} (view ${viewId})\n\n` +
                  [...plan, ...extraPlan].map((l) => `- ${l}`).join('\n') + '\n',
              );
            }

            const log: string[] = [];
            const idByTitle = new Map<string, number>();

            // 1. Create / reorder the template columns.
            for (const [i, title] of columns.entries()) {
              const position = (i + 1) * POSITION_STEP;
              const found = existingByTitle.get(title);
              if (found) {
                await updateBucket(service, projectId, viewId, found.id, bucketInput({ title: found.title, position, limit: found.limit }));
                idByTitle.set(title, found.id);
                log.push(`reordered "${title}" (${found.id}) → #${i + 1}`);
              } else {
                const created = await createBucket(service, projectId, viewId, bucketInput({ title, position }));
                idByTitle.set(title, created.id);
                log.push(`created "${title}" (${created.id}) → #${i + 1}`);
              }
            }

            // 2. Point the view's default/done at valid template columns BEFORE any delete,
            //    so relocation has a live destination and nothing gets orphaned.
            const defaultId = (args.defaultColumn ? idByTitle.get(args.defaultColumn) : undefined) ?? idByTitle.get(columns[0] ?? '');
            const doneId = args.doneColumn ? idByTitle.get(args.doneColumn) : undefined;
            await updateView(service, projectId, viewId, {
              ...view,
              ...(defaultId !== undefined && { default_bucket_id: defaultId }),
              ...(doneId !== undefined && { done_bucket_id: doneId }),
            });
            if (defaultId !== undefined) log.push(`default column → ${defaultId}`);
            if (doneId !== undefined) log.push(`done column → ${doneId}`);

            // 3. Remove extras (relocating their tasks to the new default first).
            if (args.removeExtra) {
              const refreshedView = await resolveView(service, projectId, viewId);
              for (const extra of extras) {
                const current = await bucketsWithTasks(service, projectId, viewId);
                const result = await deleteBucketSafely(service, projectId, viewId, extra.id, refreshedView, current, defaultId);
                log.push(
                  `deleted "${extra.title}" (${extra.id})` +
                    (result.movedTasks.length > 0 ? `, moved ${result.movedTasks.length} task(s) to ${result.destination}` : ''),
                );
              }
            } else if (extras.length > 0) {
              log.push(`kept ${extras.length} extra column(s): ${extras.map((e) => e.title).join(', ')} (pass removeExtra to delete)`);
            }

            return text(
              `## Applied column template to project ${projectId} (view ${viewId})\n\n${log.map((l) => `- ${l}`).join('\n')}\n`,
            );
          }

          default:
            throw new MCPError(ErrorCode.VALIDATION_ERROR, `Unknown operation: ${String(args.operation)}`);
        }
      } catch (error) {
        if (error instanceof MCPError) {
          throw error;
        }
        throw new MCPError(
          ErrorCode.INTERNAL_ERROR,
          `Kanban operation error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );
}
