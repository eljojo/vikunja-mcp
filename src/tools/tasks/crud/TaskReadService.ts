/**
 * Task Read Service
 * Handles task retrieval operations with comprehensive error handling
 */

import { MCPError, ErrorCode, getClientFromContext, transformApiError, handleFetchError, handleStatusCodeError } from '../../../index';
import { validateId } from '../validation';
import { createTaskResponse } from './TaskResponseFormatter';
import { formatAorpAsMarkdown } from '../../../utils/response-factory';
import { enrichTasksWithBucketIds } from '../../../client/applyTaskServiceCompatibility';

export interface GetTaskArgs {
  id?: number;
  projectId?: number;
  viewId?: number;
  view_id?: number;
  sessionId?: string;
}

/**
 * Retrieves a task by ID with comprehensive error handling
 */
export async function getTask(args: GetTaskArgs): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    if (!args.id) {
      throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Task id is required for get operation');
    }
    validateId(args.id, 'id');
    if (args.projectId !== undefined) {
      validateId(args.projectId, 'projectId');
    }
    const viewId = resolveViewId(args);
    if (viewId !== undefined) {
      validateId(viewId, 'viewId');
    }

    const client = await getClientFromContext();
    const task = await client.tasks.getTask(args.id);
    const enrichedTask = viewId === undefined
      ? task
      : ((await enrichTasksWithBucketIds(
          client.tasks,
          [
            {
              ...task,
              ...(args.projectId !== undefined && { project_id: args.projectId }),
            },
          ],
          viewId,
        ))[0] ?? task);

    const response = createTaskResponse(
      'get-task',
      `Retrieved task "${enrichedTask.title}"`,
      { task: enrichedTask },
      {
        timestamp: new Date().toISOString(),
        taskId: args.id,
      },
      undefined, // verbosity (ignored)
      undefined, // useOptimizedFormat (ignored)
      undefined, // useAorp (ignored)
      undefined, // aorpConfig (using auto-generated)
      args.sessionId
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: formatAorpAsMarkdown(response.response),
        },
      ],
    };
  } catch (error) {
    // Re-throw MCPError instances without modification
    if (error instanceof MCPError) {
      throw error;
    }

    // Handle fetch/connection errors with helpful guidance
    if (error instanceof Error && (
      error.message.includes('fetch failed') ||
      error.message.includes('ECONNREFUSED') ||
      error.message.includes('ENOTFOUND')
    )) {
      throw handleFetchError(error, 'get task');
    }

    // Use standardized error transformation for all other errors
    if (args.id) {
      throw handleStatusCodeError(error, 'get task', args.id, `Task with ID ${args.id} not found`);
    }
    throw transformApiError(error, 'Failed to get task');
  }
}

function resolveViewId(args: GetTaskArgs): number | undefined {
  if (
    args.viewId !== undefined &&
    args.view_id !== undefined &&
    args.viewId !== args.view_id
  ) {
    throw new MCPError(
      ErrorCode.VALIDATION_ERROR,
      'viewId and view_id must match when both are provided',
    );
  }

  return args.viewId ?? args.view_id;
}
