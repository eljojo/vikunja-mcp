/**
 * Client-side filtering strategy
 * 
 * This strategy loads all tasks from the API and then applies filtering
 * logic on the client side. This is the traditional approach that works
 * with all versions of Vikunja but may be less efficient for large datasets.
 */

import type { Task, GetTasksParams } from 'node-vikunja';
import type { TaskFilteringStrategy } from './TaskFilteringStrategy';
import type { FilteringParams, FilteringResult } from './types';
import { getClientFromContext } from '../../client';
import { validateId } from '../../tools/tasks/validation';
import { applyFilter } from '../../filters';
import { logger } from '../logger';

/**
 * Page size used when paging through the full result set. Matches Vikunja's
 * default maxItemsPerPage cap, so a returned page shorter than this reliably
 * signals the last page.
 */
const SERVER_PAGE_SIZE = 50;

/** Safety bound on pages fetched during a full load (SERVER_PAGE_SIZE * this). */
const MAX_PAGES = 100;

type TaskClient = Awaited<ReturnType<typeof getClientFromContext>>['tasks'];

/**
 * Page through the API until a short page is returned, accumulating all tasks.
 * The server caps per_page (default 50), so a single request is not the full set.
 */
async function loadAllPages(
  tasksClient: TaskClient,
  projectId: number | undefined,
  baseParams: GetTasksParams,
): Promise<Task[]> {
  const all: Task[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const pageParams: GetTasksParams = { ...baseParams, per_page: SERVER_PAGE_SIZE, page };
    const batch =
      projectId !== undefined
        ? await tasksClient.getProjectTasks(projectId, pageParams)
        : await tasksClient.getAllTasks(pageParams);
    const arr = batch ?? [];
    all.push(...arr);
    if (arr.length < SERVER_PAGE_SIZE) {
      break;
    }
  }
  return all;
}

/**
 * Fetch one logical (page, perPage) window for a plain browse. The server caps a
 * page at 50, so a requested perPage larger than that would silently truncate —
 * instead we page through 50-row server chunks until the window is filled (or the
 * set runs out), so `perPage` means what it says. Also reports whether at least
 * one task exists beyond the window, which the caller surfaces as a next-page
 * hint; a full final chunk is treated as "more may exist" (a benign
 * false-positive only when the total lands exactly on a 50-row boundary).
 */
async function loadWindow(
  tasksClient: TaskClient,
  projectId: number | undefined,
  baseParams: GetTasksParams,
  page: number,
  perPage: number,
): Promise<{ tasks: Task[]; hasMore: boolean }> {
  const startOffset = (page - 1) * perPage;
  const endOffset = page * perPage; // exclusive
  const collected: Task[] = [];
  let lastChunkFull = false;
  for (let p = 1; p <= MAX_PAGES; p++) {
    if (collected.length >= endOffset) {
      break;
    }
    const pageParams: GetTasksParams = { ...baseParams, per_page: SERVER_PAGE_SIZE, page: p };
    const batch =
      projectId !== undefined
        ? await tasksClient.getProjectTasks(projectId, pageParams)
        : await tasksClient.getAllTasks(pageParams);
    const arr = batch ?? [];
    lastChunkFull = arr.length === SERVER_PAGE_SIZE;
    collected.push(...arr);
    if (arr.length < SERVER_PAGE_SIZE) {
      break; // server exhausted
    }
  }
  const windowTasks = collected.slice(startOffset, endOffset);
  const hasMore =
    collected.length > startOffset + windowTasks.length ||
    (windowTasks.length === perPage && lastChunkFull);
  return { tasks: windowTasks, hasMore };
}

export class ClientSideFilteringStrategy implements TaskFilteringStrategy {
  async execute(params: FilteringParams): Promise<FilteringResult> {
    const { args, filterExpression, filterString, params: apiParams, loadAll } = params;

    const client = await getClientFromContext();

    // Undefined => query across all projects; a number => single project scope.
    const projectScope = args.allProjects ? undefined : args.projectId;
    if (projectScope !== undefined) {
      validateId(projectScope, 'projectId');
    }

    logger.info('Using client-side filtering', {
      filter: filterString,
      loadAll: Boolean(loadAll),
      endpoint: projectScope !== undefined ? 'getProjectTasks' : 'getAllTasks',
    });

    // Load tasks without server-side filtering. When narrowing client-side we
    // must page through the whole set, since one API page is capped at 50. A
    // plain browse instead fetches just the requested (page, perPage) window,
    // paging 50-row chunks so a perPage above the server cap isn't truncated.
    let tasks: Task[];
    let browseHasMore: boolean | undefined;
    if (loadAll) {
      tasks = await loadAllPages(client.tasks, projectScope, apiParams);
    } else {
      const perPage = apiParams.per_page ?? SERVER_PAGE_SIZE;
      const page = apiParams.page ?? 1;
      const window = await loadWindow(client.tasks, projectScope, apiParams, page, perPage);
      tasks = window.tasks;
      browseHasMore = window.hasMore;
    }

    logger.info('Tasks loaded for client-side filtering', {
      totalTasksLoaded: tasks?.length || 0,
      loadAll: Boolean(loadAll),
      filter: filterString
    });

    // Apply client-side filtering if we have a filter expression
    const safeTasks = tasks || [];
    let filteredTasks = safeTasks;

    if (filterExpression) {
      const originalCount = safeTasks.length;
      filteredTasks = applyFilter(safeTasks, filterExpression);
      logger.debug('Applied client-side filter', {
        originalCount,
        filteredCount: filteredTasks?.length || 0,
        filter: filterString,
      });
    }

    return {
      tasks: filteredTasks || [],
      metadata: {
        serverSideFilteringUsed: false,
        serverSideFilteringAttempted: false,
        clientSideFiltering: Boolean(filterExpression),
        filteringNote: 'Client-side filtering applied (server-side disabled in development)',
        ...(browseHasMore !== undefined && { hasMore: browseHasMore }),
      }
    };
  }
}
