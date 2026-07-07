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
    // must page through the whole set, since one API page is capped at 50.
    let tasks: Task[];
    if (loadAll) {
      tasks = await loadAllPages(client.tasks, projectScope, apiParams);
    } else if (projectScope !== undefined) {
      tasks = (await client.tasks.getProjectTasks(projectScope, apiParams)) ?? [];
    } else {
      tasks = (await client.tasks.getAllTasks(apiParams)) ?? [];
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
        filteringNote: 'Client-side filtering applied (server-side disabled in development)'
      }
    };
  }
}
