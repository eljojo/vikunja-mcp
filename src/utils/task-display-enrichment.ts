/**
 * Task display enrichment
 *
 * Injects display-only fields onto tasks before rendering: the human-readable
 * project name (resolved from project_id) and, on request, a relative "updated"
 * stale signal. These fields are never sent back to the API.
 */

import type { VikunjaClient, TaskService } from 'node-vikunja';
import type { Task } from '../types';
import { getProjectViews, getBucketsForView } from '../client/applyTaskServiceCompatibility';
import { logger } from './logger';

/** Cache the project id -> name map briefly to avoid refetching on every list. */
const PROJECT_NAME_TTL_MS = 60_000;
let projectNameCache: { at: number; map: Map<number, string> } | null = null;

interface ProjectLike {
  id?: number;
  title?: string;
}

/**
 * Fetch (and briefly cache) a map of project id -> title. Tolerates both the
 * array and `{ data: [...] }` response shapes the client can return.
 */
export async function getProjectNameMap(client: VikunjaClient): Promise<Map<number, string>> {
  const now = Date.now();
  if (projectNameCache && now - projectNameCache.at < PROJECT_NAME_TTL_MS) {
    return projectNameCache.map;
  }

  const map = new Map<number, string>();
  try {
    const response = (await client.projects.getProjects({ per_page: 1000 })) as
      | ProjectLike[]
      | { data?: ProjectLike[] };
    const projects: ProjectLike[] = Array.isArray(response) ? response : response?.data ?? [];
    for (const project of projects) {
      if (project.id !== undefined && project.title !== undefined) {
        map.set(project.id, project.title);
      }
    }
    projectNameCache = { at: now, map };
  } catch (error) {
    // Name resolution is best-effort; fall back to bare ids on failure.
    logger.warn('Could not resolve project names for task display', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return map;
}

/**
 * Compact relative age of an ISO timestamp (e.g. "today", "5d ago", "3mo ago").
 * Returns undefined for missing or zero-value dates.
 */
export function relativeAge(iso?: string): string | undefined {
  if (!iso || iso.startsWith('0001-01-01')) {
    return undefined;
  }
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return undefined;
  }

  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return '1d ago';
  if (days < 30) return `${days}d ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;

  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

/**
 * Cache each project's board (kanban) view id. View ids are stable, so this
 * avoids re-fetching the view list on every list call. `null` = no board view.
 */
const boardViewIdCache = new Map<number, number | null>();

async function getBoardViewId(taskService: TaskService, projectId: number): Promise<number | null> {
  const cached = boardViewIdCache.get(projectId);
  if (cached !== undefined) {
    return cached;
  }
  let viewId: number | null = null;
  try {
    const views = await getProjectViews(taskService, projectId);
    viewId = (views ?? []).find((v) => v.view_kind === 'kanban')?.id ?? null;
  } catch (error) {
    logger.warn('Could not read project views for bucket resolution', {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  boardViewIdCache.set(projectId, viewId);
  return viewId;
}

/**
 * Attach each task's kanban column (board-view bucket title) as `bucket_title`.
 * Best-effort: on any failure the task keeps no bucket_title. Buckets come back
 * from the board view already carrying their tasks, so one call per project
 * yields the full task -> column mapping. Mutates the passed tasks.
 */
export async function enrichTasksWithBucketTitles(
  taskService: TaskService,
  tasks: Task[],
): Promise<void> {
  const byProject = new Map<number, Task[]>();
  for (const task of tasks) {
    if (task.project_id === undefined) {
      continue;
    }
    const group = byProject.get(task.project_id);
    if (group) {
      group.push(task);
    } else {
      byProject.set(task.project_id, [task]);
    }
  }

  await Promise.all(
    Array.from(byProject.entries()).map(async ([projectId, projectTasks]) => {
      try {
        const viewId = await getBoardViewId(taskService, projectId);
        if (viewId === null) {
          return;
        }
        const buckets = await getBucketsForView(taskService, projectId, viewId);
        const titleByTaskId = new Map<number, string>();
        for (const bucket of buckets ?? []) {
          if (!bucket.title || !Array.isArray(bucket.tasks)) {
            continue;
          }
          for (const bucketTask of bucket.tasks) {
            if (bucketTask.id !== undefined) {
              titleByTaskId.set(bucketTask.id, bucket.title);
            }
          }
        }
        for (const task of projectTasks) {
          const title = task.id === undefined ? undefined : titleByTaskId.get(task.id);
          if (title !== undefined) {
            task.bucket_title = title;
          }
        }
      } catch (error) {
        logger.warn('Could not resolve kanban columns for project', {
          projectId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );
}

/**
 * Attach each task's comments. Always sets `comment_count`; sets the full
 * `comments` array only when `full` is requested (the deep-read path). Costs
 * one API call per task, so the caller restricts this to single-project ("zoom
 * in") lists and never a cross-project scan. Best-effort: a task whose comments
 * can't be read keeps no count rather than failing the whole list.
 */
export async function enrichTasksWithComments(
  taskService: TaskService,
  tasks: Task[],
  options: { full?: boolean } = {},
): Promise<void> {
  await Promise.all(
    tasks.map(async (task) => {
      if (task.id === undefined) {
        return;
      }
      try {
        const comments = await taskService.getTaskComments(task.id);
        task.comment_count = comments.length;
        if (options.full) {
          task.comments = comments;
        }
      } catch (error) {
        logger.debug('Comment enrichment skipped for task', {
          taskId: task.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );
}

/**
 * Attach display-only fields (project name, optional stale signal) to tasks.
 * Mutates and returns the same array for convenience.
 */
export function enrichTasksForDisplay(
  tasks: Task[],
  projectNames: Map<number, string>,
  options: { showUpdated?: boolean } = {},
): Task[] {
  for (const task of tasks) {
    const name = projectNames.get(task.project_id);
    if (name !== undefined) {
      task.project_title = name;
    }
    if (options.showUpdated) {
      const age = relativeAge(task.updated);
      if (age !== undefined) {
        task.updated_relative = age;
      }
    }
  }
  return tasks;
}
