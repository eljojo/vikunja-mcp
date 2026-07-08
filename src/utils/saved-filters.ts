/**
 * Vikunja saved-filter helpers.
 *
 * Vikunja stores saved filters as first-class objects reachable at `/filters/{id}`,
 * but ALSO surfaces them in the projects list as negative-ID pseudo-projects so the
 * web app and mobile can show them alongside real projects. The two id spaces are
 * related by `projectID = -filterID - 1` (see Vikunja's models/saved_filters.go).
 */

import type { VikunjaClient, SavedFilter } from 'node-vikunja';
import { MCPError, ErrorCode } from '../types';

/** Convert a saved-filter pseudo-project id (negative) to its real filter id (positive). */
export function filterIdFromProjectId(projectId: number): number {
  return -projectId - 1;
}

/** Convert a real filter id (positive) to its pseudo-project id (negative). */
export function projectIdFromFilterId(filterId: number): number {
  return -filterId - 1;
}

/** The Vikunja filter DSL string a saved filter wraps (nested under `filters.filter`). */
export function savedFilterQuery(filter: SavedFilter): string | undefined {
  return (filter.filters as { filter?: string } | undefined)?.filter;
}

/**
 * Resolve a Vikunja saved filter to its filter-DSL string by filter id. Used when a
 * task list is requested with `filterId` — the query is fetched from the server and
 * then run through the normal hybrid filter engine.
 */
export async function resolveSavedFilterQuery(
  client: VikunjaClient,
  filterId: string | number,
): Promise<string> {
  const id = Number(filterId);
  if (!Number.isFinite(id)) {
    throw new MCPError(ErrorCode.VALIDATION_ERROR, `Invalid saved filter id: ${filterId}`);
  }
  const filter = await client.filters.getFilter(id);
  const query = savedFilterQuery(filter);
  if (!query) {
    throw new MCPError(ErrorCode.NOT_FOUND, `Saved filter ${filterId} not found or has no query`);
  }
  return query;
}
