/**
 * Label operations for tasks
 */

import type { MinimalTask } from '../../types';
import { MCPError, ErrorCode } from '../../types';
import { getClientFromContext } from '../../client';
import { isAuthenticationError } from '../../utils/auth-error-handler';
import { withRetry, RETRY_CONFIG } from '../../utils/retry';
import { validateId } from './validation';
import { createSimpleResponse, formatAorpAsMarkdown } from '../../utils/response-factory';
import { getTaskWithRelationships } from './relationship-verification';

/**
 * Add labels to a task
 */
export async function applyLabels(args: {
  id?: number;
  labels?: number[];
}): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    if (!args.id) {
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        'Task id is required for apply-label operation',
      );
    }
    validateId(args.id, 'id');

    if (!args.labels || args.labels.length === 0) {
      throw new MCPError(ErrorCode.VALIDATION_ERROR, 'At least one label id is required');
    }

    // Validate label IDs
    args.labels.forEach((id) => validateId(id, 'label ID'));

    const client = await getClientFromContext();
    const taskId = args.id;
    const labelIds = args.labels;

    const currentTask = await client.tasks.getTask(taskId);
    const currentLabelIds = currentTask.labels
      ?.map((label) => label.id)
      .filter((id): id is number => id !== undefined) ?? [];
    const finalLabelIds = [...new Set([...currentLabelIds, ...labelIds])];

    try {
      await withRetry(
        () => client.tasks.updateTaskLabels(taskId, { label_ids: finalLabelIds }),
        {
          ...RETRY_CONFIG.AUTH_ERRORS,
          shouldRetry: (error: unknown) => isAuthenticationError(error),
        },
      );
    } catch (labelError) {
      if (isAuthenticationError(labelError)) {
        throw new MCPError(
          ErrorCode.API_ERROR,
          `Failed to apply label to task (Retried ${RETRY_CONFIG.AUTH_ERRORS.maxRetries} times)`,
        );
      }
      throw relationshipOperationError('labels', taskId, labelError);
    }

    // Fetch the updated task to show current labels
    const task = await getTaskWithRelationships(client, taskId, {
      labels: finalLabelIds,
    });
    verifyRelationshipIds(
      'labels',
      taskId,
      finalLabelIds,
      task.labels?.map((label) => label.id) ?? [],
    );

    const response = createSimpleResponse(
      'apply-label',
      `Label${labelIds.length > 1 ? 's' : ''} applied to task successfully`,
      { task },
      { metadata: { affectedFields: ['labels'] } }
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: formatAorpAsMarkdown(response),
        },
      ],
    };
  } catch (error) {
    throw new MCPError(
      ErrorCode.API_ERROR,
      `Failed to apply labels to task: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function verifyRelationshipIds(
  relationship: 'labels',
  taskId: number,
  expectedIds: number[],
  actualIds: Array<number | undefined>,
): void {
  const actual = new Set(actualIds.filter((id): id is number => id !== undefined));
  const missing = expectedIds.filter((id) => !actual.has(id));
  if (missing.length > 0) {
    throw new MCPError(
      ErrorCode.API_ERROR,
      `Task ${taskId} is missing requested ${relationship}: ${missing.join(', ')}`,
    );
  }
}

function relationshipOperationError(
  relationship: 'labels',
  taskId: number,
  error: unknown,
): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/task does not exist|task not found/i.test(message)) {
    return new MCPError(
      ErrorCode.API_ERROR,
      `Task ${taskId} is readable but ${relationship} could not be changed. Check that the Vikunja API token allows task ${relationship} routes. Original error: ${message}`,
    );
  }
  return error instanceof Error ? error : new Error(message);
}

/**
 * Remove labels from a task
 */
export async function removeLabels(args: {
  id?: number;
  labels?: number[];
}): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    if (!args.id) {
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        'Task id is required for remove-label operation',
      );
    }
    validateId(args.id, 'id');

    if (!args.labels || args.labels.length === 0) {
      throw new MCPError(ErrorCode.VALIDATION_ERROR, 'At least one label id is required to remove');
    }

    // Validate label IDs
    args.labels.forEach((id) => validateId(id, 'label ID'));

    const client = await getClientFromContext();
    const taskId = args.id;
    const labelIds = args.labels;

    // Remove labels from the task with retry logic
    for (const labelId of labelIds) {
      try {
        await withRetry(() => client.tasks.removeLabelFromTask(taskId, labelId), {
          ...RETRY_CONFIG.AUTH_ERRORS,
          shouldRetry: (error: unknown) => isAuthenticationError(error),
        });
      } catch (removeError) {
        // Check if it's an auth error after retries
        if (isAuthenticationError(removeError)) {
          throw new MCPError(
            ErrorCode.API_ERROR,
            `Failed to remove label from task (Retried ${RETRY_CONFIG.AUTH_ERRORS.maxRetries} times)`,
          );
        }
        throw removeError;
      }
    }

    // Fetch the updated task to show current labels
    const task = await client.tasks.getTask(args.id);

    const response = createSimpleResponse(
      'remove-label',
      `Label${labelIds.length > 1 ? 's' : ''} removed from task successfully`,
      { task },
      { metadata: { affectedFields: ['labels'] } }
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: formatAorpAsMarkdown(response),
        },
      ],
    };
  } catch (error) {
    throw new MCPError(
      ErrorCode.API_ERROR,
      `Failed to remove labels from task: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * List labels of a task
 */
export async function listTaskLabels(args: {
  id?: number;
}): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    if (args.id === undefined) {
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        'Task id is required for list-labels operation',
      );
    }
    validateId(args.id, 'id');

    const client = await getClientFromContext();

    // Fetch the task to get current labels
    const task = await client.tasks.getTask(args.id);

    const labels = task.labels || [];

    const minimalTask: MinimalTask = {
      ...(task.id !== undefined && { id: task.id }),
      title: task.title,
    };

    const response = createSimpleResponse(
      'list-labels',
      `Task has ${labels.length} label(s)`,
      { task: { ...minimalTask, labels: labels } },
      { metadata: { count: labels.length } }
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: formatAorpAsMarkdown(response),
        },
      ],
    };
  } catch (error) {
    if (error instanceof MCPError) {
      throw error;
    }
    throw new MCPError(
      ErrorCode.API_ERROR,
      `Failed to list task labels: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
