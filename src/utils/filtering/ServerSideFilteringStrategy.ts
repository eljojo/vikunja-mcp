/**
 * Server-side filtering strategy
 * 
 * This strategy attempts to use Vikunja's server-side filtering capabilities
 * by passing filter parameters directly to the API. This is the most efficient
 * approach when the server supports advanced filtering.
 */

import type { Task } from 'node-vikunja';
import type { TaskFilteringStrategy } from './TaskFilteringStrategy';
import type { FilteringParams, FilteringResult } from './types';
import { getClientFromContext } from '../../client';
import { validateId } from '../../tools/tasks/validation';
import { logger } from '../logger';
import { MCPError, ErrorCode } from '../../types';

/** Vikunja caps a page at this regardless of what per_page asks for. */
const SERVER_PAGE_SIZE = 50;

/** Safety bound on pages fetched during a full load (SERVER_PAGE_SIZE * this). */
const MAX_PAGES = 100;

export class ServerSideFilteringStrategy implements TaskFilteringStrategy {
  async execute(params: FilteringParams): Promise<FilteringResult> {
    const { args, filterString, params: apiParams, loadAll } = params;

    if (!filterString) {
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        'Server-side filtering requires a filter string'
      );
    }

    const client = await getClientFromContext();
    const serverParams = { ...apiParams, filter: filterString };

    logger.info('Attempting server-side filtering', {
      filter: filterString,
      endpoint: args.projectId && !args.allProjects ? 'getProjectTasks' : 'getAllTasks'
    });

    const forProject = args.projectId !== undefined && !args.allProjects;
    const fetchPage = async (pageParams: typeof serverParams): Promise<Task[]> => {
      if (forProject) {
        validateId(args.projectId as number, 'projectId');
        return (await client.tasks.getProjectTasks(args.projectId as number, pageParams)) ?? [];
      }
      return (await client.tasks.getAllTasks(pageParams)) ?? [];
    };

    let tasks: Task[];
    try {
      if (loadAll) {
        // The caller narrows further in memory (by bucket or done state), which
        // only works against the whole match set — and the server caps a page at
        // 50 however large per_page is. One request would hand back a truncated
        // set that the narrowing then silently reports as complete.
        tasks = [];
        for (let page = 1; page <= MAX_PAGES; page++) {
          const batch = await fetchPage({ ...serverParams, per_page: SERVER_PAGE_SIZE, page });
          tasks.push(...batch);
          if (batch.length < SERVER_PAGE_SIZE) {
            break;
          }
        }
      } else {
        tasks = await fetchPage(serverParams);
      }

      logger.info('Server-side filtering completed successfully', {
        taskCount: tasks.length,
        filter: filterString
      });

      return {
        tasks,
        metadata: {
          serverSideFilteringUsed: true,
          serverSideFilteringAttempted: true,
          clientSideFiltering: false,
          filteringNote: 'Server-side filtering used (modern Vikunja)',
          ...(loadAll ? { loadedAll: true } : {}),
        }
      };

    } catch (error) {
      logger.error('Server-side filtering failed', {
        error: error instanceof Error ? error.message : String(error),
        filter: filterString
      });
      
      // Re-throw the error to be handled by the calling code
      throw error;
    }
  }
}