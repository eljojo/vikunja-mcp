/**
 * Task display enrichment
 *
 * Injects display-only fields onto tasks before rendering: the human-readable
 * project name (resolved from project_id) and, on request, a relative "updated"
 * stale signal. These fields are never sent back to the API.
 */

import type { VikunjaClient } from 'node-vikunja';
import type { Task } from '../types';
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
