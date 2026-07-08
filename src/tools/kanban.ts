/**
 * Kanban Tool
 * Manage a project's Kanban board: views, buckets (columns), task placement.
 *
 * Buckets belong to a project's Kanban *view*, so every op needs a viewId. It is
 * auto-resolved to the project's `view_kind === 'kanban'` view when not given, so
 * callers work in terms of project + column name, not opaque view/bucket ids.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { TaskService } from 'node-vikunja';
import type { AuthManager } from '../auth/AuthManager';
import type { VikunjaClientFactory } from '../client/VikunjaClientFactory';
import { MCPError, ErrorCode } from '../types';
import { getClientFromContext, setGlobalClientFactory } from '../client';
import { createAuthRequiredError } from '../utils/error-handler';
import { createSuccessResponse, formatMcpResponse } from '../utils/simple-response';
import {
  getProjectViews,
  getViewBuckets,
  getBucketsForView,
  createBucket,
  updateBucket,
  deleteBucket,
  updateView,
  moveTaskToBucket,
  type TaskBucket,
  type ProjectViewLite,
  type BucketInput,
} from '../client/applyTaskServiceCompatibility';

/** Vikunja orders buckets by a float `position`; this is its native step. */
const POSITION_STEP = 65536;

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

/** Resolve the project's Kanban view id, or throw if it has none. */
async function resolveKanbanViewId(service: TaskService, projectId: number): Promise<number> {
  const views = (await getProjectViews(service, projectId)) ?? [];
  const kanban = views.find((v) => v.view_kind === 'kanban');
  if (!kanban) {
    throw new MCPError(
      ErrorCode.NOT_FOUND,
      `Project ${projectId} has no Kanban view`,
    );
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

/** Buckets sorted by their display order. */
async function orderedBuckets(service: TaskService, projectId: number, viewId: number): Promise<TaskBucket[]> {
  const buckets = (await getViewBuckets(service, projectId, viewId)) ?? [];
  return [...buckets].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

/** Task counts per bucket id, read from the board's tasks-by-bucket endpoint. */
async function bucketCounts(service: TaskService, projectId: number, viewId: number): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  try {
    const withTasks = (await getBucketsForView(service, projectId, viewId)) ?? [];
    for (const bucket of withTasks) {
      counts.set(bucket.id, Array.isArray(bucket.tasks) ? bucket.tasks.length : 0);
    }
  } catch {
    // counts are best-effort
  }
  return counts;
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
      'viewId auto-resolves to the project Kanban view when omitted.',
    {
      operation: z.enum([
        'list-views',
        'list-buckets',
        'create-bucket',
        'update-bucket',
        'delete-bucket',
        'move-task',
        'bulk-move',
        'set-view-config',
        'apply-template',
      ]),
      projectId: z.number().int().positive(),
      viewId: z.number().int().positive().optional(),
      bucketId: z.number().int().positive().optional(),
      taskId: z.number().int().positive().optional(),
      taskIds: z.array(z.number().int().positive()).optional(),
      title: z.string().min(1).optional(),
      position: z.number().optional(),
      limit: z.number().int().min(0).optional(),
      // set-view-config
      defaultBucketId: z.number().int().positive().optional(),
      doneBucketId: z.number().int().positive().optional(),
      // apply-template
      columns: z.array(z.string().min(1)).optional(),
      doneColumn: z.string().optional(),
      defaultColumn: z.string().optional(),
      removeExtra: z.boolean().optional(),
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
              `## Views for project ${projectId}\n\n` +
                `| View ID | Title | Kind |\n| --- | --- | --- |\n${rows}\n`,
            );
          }

          case 'list-buckets': {
            const viewId = args.viewId ?? (await resolveKanbanViewId(service, projectId));
            const [view, buckets, counts] = await Promise.all([
              resolveView(service, projectId, viewId),
              orderedBuckets(service, projectId, viewId),
              bucketCounts(service, projectId, viewId),
            ]);
            return text(
              `## Kanban columns — project ${projectId}, view ${viewId}\n\n` +
                `${formatBucketTable(buckets, view, counts)}\n`,
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
            const response = createSuccessResponse(
              'create-bucket',
              `Created column "${args.title}" (bucket ${created.id}) in project ${projectId}`,
              undefined,
              { bucketId: created.id, viewId, projectId },
            );
            return { content: formatMcpResponse(response) };
          }

          case 'update-bucket': {
            if (args.bucketId === undefined) {
              throw new MCPError(ErrorCode.VALIDATION_ERROR, 'bucketId is required to update a bucket');
            }
            const viewId = args.viewId ?? (await resolveKanbanViewId(service, projectId));
            // Read-merge-write so unspecified fields aren't reset.
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
            await deleteBucket(service, projectId, viewId, args.bucketId);
            return text(`Deleted column ${args.bucketId} from project ${projectId} (view ${viewId})`);
          }

          case 'move-task': {
            if (args.taskId === undefined || args.bucketId === undefined) {
              throw new MCPError(ErrorCode.VALIDATION_ERROR, 'taskId and bucketId are required to move a task');
            }
            const viewId = args.viewId ?? (await resolveKanbanViewId(service, projectId));
            await moveTaskToBucket(service, projectId, viewId, args.bucketId, args.taskId);
            return text(`Moved task ${args.taskId} to column ${args.bucketId} (project ${projectId})`);
          }

          case 'bulk-move': {
            if (!args.taskIds || args.taskIds.length === 0 || args.bucketId === undefined) {
              throw new MCPError(ErrorCode.VALIDATION_ERROR, 'taskIds and bucketId are required for bulk-move');
            }
            const viewId = args.viewId ?? (await resolveKanbanViewId(service, projectId));
            const results = await Promise.allSettled(
              args.taskIds.map((taskId) => moveTaskToBucket(service, projectId, viewId, args.bucketId as number, taskId)),
            );
            const moved = results.filter((r) => r.status === 'fulfilled').length;
            const failed = args.taskIds.length - moved;
            return text(
              `Moved ${moved}/${args.taskIds.length} tasks to column ${args.bucketId}` +
                (failed > 0 ? ` (${failed} failed)` : ''),
            );
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
              `Set view ${viewId} config — default bucket ${updated.default_bucket_id}, ` +
                `done bucket ${updated.done_bucket_id}`,
            );
          }

          case 'apply-template': {
            if (!args.columns || args.columns.length === 0) {
              throw new MCPError(ErrorCode.VALIDATION_ERROR, 'columns (ordered list) is required for apply-template');
            }
            const viewId = args.viewId ?? (await resolveKanbanViewId(service, projectId));
            const existing = await orderedBuckets(service, projectId, viewId);
            const byTitle = new Map(existing.map((b) => [b.title ?? '', b]));
            const log: string[] = [];
            const idByTitle = new Map<string, number>();

            // Create missing / reorder existing to match the given order.
            for (const [i, title] of args.columns.entries()) {
              const position = (i + 1) * POSITION_STEP;
              const found = byTitle.get(title);
              if (found) {
                await updateBucket(
                  service,
                  projectId,
                  viewId,
                  found.id,
                  bucketInput({ title: found.title, position, limit: found.limit }),
                );
                idByTitle.set(title, found.id);
                log.push(`reordered "${title}" (${found.id}) → #${i + 1}`);
              } else {
                const created = await createBucket(service, projectId, viewId, bucketInput({ title, position }));
                idByTitle.set(title, created.id);
                log.push(`created "${title}" (${created.id}) → #${i + 1}`);
              }
            }

            // Extra columns not in the template.
            const extras = existing.filter((b) => !args.columns?.includes(b.title ?? ''));
            if (args.removeExtra) {
              for (const extra of extras) {
                await deleteBucket(service, projectId, viewId, extra.id);
                log.push(`deleted extra "${extra.title}" (${extra.id})`);
              }
            } else if (extras.length > 0) {
              log.push(`kept ${extras.length} extra column(s): ${extras.map((e) => e.title).join(', ')} (pass removeExtra to delete)`);
            }

            // Default / done bucket by name.
            const defaultId = args.defaultColumn ? idByTitle.get(args.defaultColumn) : undefined;
            const doneId = args.doneColumn ? idByTitle.get(args.doneColumn) : undefined;
            if (defaultId !== undefined || doneId !== undefined) {
              const view = await resolveView(service, projectId, viewId);
              await updateView(service, projectId, viewId, {
                ...view,
                ...(defaultId !== undefined && { default_bucket_id: defaultId }),
                ...(doneId !== undefined && { done_bucket_id: doneId }),
              });
              if (defaultId !== undefined) log.push(`default column → "${args.defaultColumn}"`);
              if (doneId !== undefined) log.push(`done column → "${args.doneColumn}"`);
            }

            return text(
              `## Applied column template to project ${projectId} (view ${viewId})\n\n` +
                log.map((l) => `- ${l}`).join('\n') + '\n',
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
