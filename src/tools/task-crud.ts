/**
 * Individual Task CRUD Tool
 * Handles basic task operations: create, get, update, delete, list
 * Replaces monolithic tasks tool with focused individual tool
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthManager } from '../auth/AuthManager';
import type { VikunjaClientFactory } from '../client/VikunjaClientFactory';
import type { Task } from '../types';
import { MCPError, ErrorCode } from '../types';
import { getClientFromContext, setGlobalClientFactory } from '../client';
import { logger } from '../utils/logger';
import { storageManager } from '../storage/index';
import type { TaskListingArgs } from './tasks/types/filters';
import type { CreateTaskArgs, UpdateTaskArgs, DeleteTaskArgs, GetTaskArgs } from './tasks/crud/index';
import { TaskFilteringOrchestrator } from './tasks/filtering/index';
import { createAuthRequiredError, handleFetchError } from '../utils/error-handler';
import { createSuccessResponse, formatMcpResponse } from '../utils/simple-response';
import { getProjectNameMap, enrichTasksForDisplay, enrichTasksWithBucketTitles } from '../utils/task-display-enrichment';
import { resolveSavedFilterQuery } from '../utils/saved-filters';

/**
 * Get session-scoped storage instance
 */
async function getSessionStorage(authManager: AuthManager): ReturnType<typeof storageManager.getStorage> {
  const session = authManager.getSession();
  const sessionId = session.apiToken ? `${session.apiUrl}:${session.apiToken.substring(0, 8)}` : 'anonymous';
  return storageManager.getStorage(sessionId, session.userId, session.apiUrl);
}

/**
 * List tasks with optional filtering
 */
async function listTasks(
  args: TaskListingArgs,
  storage: Awaited<ReturnType<typeof storageManager.getStorage>>,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    // A `filterId` references a Vikunja saved filter: resolve it to its query string
    // server-side, then let the normal hybrid engine run it. (Saved filters live in
    // Vikunja now, not in local storage.)
    if (args.filterId) {
      const client = await getClientFromContext();
      args.filter = await resolveSavedFilterQuery(client, args.filterId);
      delete args.filterId;
    }

    // Execute the complete filtering workflow using the orchestrator
    const filteringResult = await TaskFilteringOrchestrator.executeTaskFiltering(args, storage);

    // Determine filtering method message
    let filteringMessage = '';
    if (args.filter) {
      if (filteringResult.metadata?.serverSideFilteringUsed) {
        filteringMessage = ' (filtered server-side)';
      } else if (filteringResult.metadata?.serverSideFilteringAttempted) {
        filteringMessage = ' (filtered client-side - server-side fallback)';
      } else {
        filteringMessage = ' (filtered client-side)';
      }
    }

    const tasks = (filteringResult.tasks || []) as Task[];
    const metadata = filteringResult.metadata || {};

    // Enrich with display-only fields: project name (so lists read as areas of
    // life, not opaque ids) and, on request, a relative "updated" stale signal.
    // For a single-project ("zoom in") list, also resolve each task's kanban
    // column — key to what the task means — which costs a couple of extra calls
    // and so is skipped for cross-project reads.
    const singleProject = args.projectId !== undefined && !args.allProjects;
    try {
      const client = await getClientFromContext();
      const projectNames = await getProjectNameMap(client);
      enrichTasksForDisplay(tasks, projectNames, { showUpdated: Boolean(args.showUpdated) });
      if (singleProject) {
        await enrichTasksWithBucketTitles(client.tasks, tasks);
      }
    } catch (error) {
      logger.debug('Task display enrichment skipped', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Type the filtering metadata properly
    const filteringMetadata = metadata;

    const response = createSuccessResponse(
      'list-tasks',
      `Found ${tasks.length} tasks${filteringMessage}`,
      // Show the done column unless the query already pins done state.
      { tasks, taskTableOptions: { showDone: args.done === undefined } },
      {
        count: tasks.length,
        filteringMethod: filteringMetadata.serverSideFilteringUsed ? 'server-side' :
                           filteringMetadata.serverSideFilteringAttempted ? 'client-side-fallback' : 'client-side',
        ...metadata,
      }
    );

    logger.debug('Task CRUD tool response', { operation: 'list', itemCount: tasks.length });

    return {
      content: formatMcpResponse(response)
    };
  } catch (error) {
    if (error instanceof MCPError) {
      throw error;
    }

    // Log the full error for debugging filter issues
    logger.error('Task list error:', {
      error: error instanceof Error ? error.message : String(error),
      filter: args.filter,
      filterId: args.filterId,
    });

    throw handleFetchError(error, 'list tasks');
  }
}

/**
 * Register individual task CRUD tool
 */
export function registerTaskCrudTool(
  server: McpServer,
  authManager: AuthManager,
  clientFactory?: VikunjaClientFactory
): void {
  server.tool(
    'vikunja_task_crud',
    'Manage individual tasks: create, get, update, delete, list',
    {
      operation: z.enum(['create', 'get', 'update', 'delete', 'list']),
      // Task creation/update fields
      title: z.string().optional(),
      description: z.string().optional(),
      projectId: z.number().optional(),
      bucketId: z.number().int().positive().optional(),
      bucket_id: z.number().int().positive().optional(),
      viewId: z.number().int().positive().optional(),
      view_id: z.number().int().positive().optional(),
      dueDate: z.string().optional(),
      priority: z.number().min(0).max(5).optional(),
      labels: z.array(z.number()).optional(),
      assignees: z.array(z.number()).optional(),
      // Recurring task fields
      repeatAfter: z.number().min(0).optional(),
      repeatMode: z.enum(['day', 'week', 'month', 'year']).optional(),
      // Query fields
      id: z.number().optional(),
      filter: z.string().optional(),
      filterId: z.string().optional(),
      page: z.number().optional(),
      perPage: z.number().optional(),
      sort: z.string().optional(),
      search: z.string().optional(),
      // List specific filters
      allProjects: z.boolean().optional(),
      done: z.boolean().optional(),
      // Include a relative "updated Xmo ago" stale signal per task (off by default)
      showUpdated: z.boolean().optional(),
      // Session ID for AORP response tracking
      sessionId: z.string().optional(),
    },
    async (args) => {
      try {
        logger.debug('Executing task CRUD tool', { operation: args.operation, args });

        // Check authentication
        if (!authManager.isAuthenticated()) {
          throw createAuthRequiredError('access task CRUD operations');
        }

        // Set the client factory for this request if provided
        if (clientFactory) {
          await setGlobalClientFactory(clientFactory);
        }

        // Test client connection
        await getClientFromContext();

        switch (args.operation) {
          case 'list': {
            const storage = await getSessionStorage(authManager);
            return listTasks(args as Parameters<typeof listTasks>[0], storage);
          }

          case 'create': {
            const { createTask } = await import('./tasks/crud/index.js');
            // Filter args to ensure required properties are present
            if (args.projectId === undefined) {
              throw new MCPError(ErrorCode.VALIDATION_ERROR, 'projectId is required to create a task');
            }
            return createTask(args as CreateTaskArgs);
          }

          case 'get': {
            const { getTask } = await import('./tasks/crud/index.js');
            // Filter args to ensure required properties are present
            if (args.id === undefined) {
              throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Task ID is required to get a task');
            }
            return getTask(args as GetTaskArgs);
          }

          case 'update': {
            const { updateTask } = await import('./tasks/crud/index.js');
            // Filter args to ensure required properties are present
            if (args.id === undefined) {
              throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Task ID is required to update a task');
            }
            return updateTask(args as UpdateTaskArgs);
          }

          case 'delete': {
            const { deleteTask } = await import('./tasks/crud/index.js');
            // Filter args to ensure required properties are present
            if (args.id === undefined) {
              throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Task ID is required to delete a task');
            }
            return deleteTask(args as DeleteTaskArgs);
          }

          default:
            throw new MCPError(
              ErrorCode.VALIDATION_ERROR,
              `Unknown operation: ${String(args.operation)}`,
            );
        }
      } catch (error) {
        if (error instanceof MCPError) {
          throw error;
        }
        throw new MCPError(
          ErrorCode.INTERNAL_ERROR,
          `Task CRUD operation error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );
}
