/**
 * Task Creation Service
 * Handles task creation with label/assignee management and rollback logic
 */

import { MCPError, ErrorCode } from '../../../types';
import { getClientFromContext } from '../../../client';
import type { Task, TaskService, VikunjaClient } from 'node-vikunja';
import {
  getProjectViews,
  getBucketsForView,
  moveTaskToBucket,
} from '../../../client/applyTaskServiceCompatibility';
import { logger } from '../../../utils/logger';
import { isAuthenticationError } from '../../../utils/auth-error-handler';
import { RETRY_CONFIG } from '../../../utils/retry';
import { transformApiError, handleFetchError } from '../../../utils/error-handler';
import { sanitizeUserText } from '../../../utils/validation';
import { AUTH_ERROR_MESSAGES } from '../constants';
import { validateDateString, expandDateOnly, validateId, convertRepeatConfiguration } from '../validation';
import { createTaskResponse } from './TaskResponseFormatter';
import { formatAorpAsMarkdown } from '../../../utils/response-factory';
import { getTaskWithRelationships } from '../relationship-verification';

export interface CreateTaskArgs {
  projectId?: number;
  title?: string;
  description?: string;
  dueDate?: string;
  priority?: number;
  labels?: number[];
  assignees?: number[];
  repeatAfter?: number;
  repeatMode?: 'day' | 'week' | 'month' | 'year';
  // Kanban placement: which column the new task should land in. Vikunja ignores
  // a bucket id supplied at creation time, so this is applied via a follow-up
  // move. viewId is optional and defaults to the project's Kanban view.
  bucketId?: number;
  bucket_id?: number;
  viewId?: number;
  view_id?: number;
  // Session ID for AORP response tracking
  sessionId?: string;
}

/**
 * Internal interface for tracking creation state during rollback scenarios
 */
interface CreationState {
  createdTask: Task;
  labelsAdded: boolean;
  assigneesAdded: boolean;
}

/**
 * Creates a new task with comprehensive error handling and rollback support
 */
export async function createTask(args: CreateTaskArgs): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    // Validate required fields
    if (!args.projectId) {
      throw new MCPError(ErrorCode.VALIDATION_ERROR, 'projectId is required to create a task');
    }
    validateId(args.projectId, 'projectId');

    if (!args.title) {
      throw new MCPError(ErrorCode.VALIDATION_ERROR, 'title is required to create a task');
    }

    // Task title/description are free text stored by Vikunja (which sanitizes rich-text
    // server-side). Only strip never-valid control chars — don't block or escape prose.
    const sanitizedTitle = sanitizeUserText(args.title);
    // Preserve empty strings as they are valid descriptions
    const sanitizedDescription = args.description !== undefined ? sanitizeUserText(args.description) : undefined;

    // Validate optional date fields
    if (args.dueDate) {
      validateDateString(args.dueDate, 'dueDate');
    }

    // Validate assignee IDs upfront
    if (args.assignees && args.assignees.length > 0) {
      args.assignees.forEach((id) => validateId(id, 'assignee ID'));
    }
    if (args.labels && args.labels.length > 0) {
      args.labels.forEach((id) => validateId(id, 'label ID'));
    }

    const client = await getClientFromContext();

    // Build the initial task object with sanitized values
    const newTask: Task = {
      title: sanitizedTitle,
      project_id: args.projectId,
    };

    // Add optional fields with sanitized values
    if (sanitizedDescription !== undefined) newTask.description = sanitizedDescription;
    if (args.dueDate !== undefined) newTask.due_date = expandDateOnly(args.dueDate);
    if (args.priority !== undefined) newTask.priority = args.priority;

    // Handle repeat configuration
    if (args.repeatAfter !== undefined || args.repeatMode !== undefined) {
      const repeatConfig = convertRepeatConfiguration(args.repeatAfter, args.repeatMode);
      if (repeatConfig.repeat_after !== undefined) newTask.repeat_after = repeatConfig.repeat_after;
      if (repeatConfig.repeat_mode !== undefined) {
        // Use index signature to bypass type mismatch - API expects number but node-vikunja types expect string
        (newTask as Record<string, unknown>).repeat_mode = repeatConfig.repeat_mode;
      }
    }

    // Create the base task
    const createdTask = await client.tasks.createTask(args.projectId, newTask);

    // Track creation state for potential rollback
    const creationState: CreationState = {
      createdTask,
      labelsAdded: false,
      assigneesAdded: false
    };

    let completeTask = createdTask;
    try {
      // Add labels if provided
      if (args.labels && args.labels.length > 0 && createdTask.id) {
        await addLabelsToTask(client, createdTask.id, args.labels);
        creationState.labelsAdded = true;
      }

      // Add assignees if provided
      if (args.assignees && args.assignees.length > 0 && createdTask.id) {
        await addAssigneesToTask(client, createdTask.id, args.assignees);
        creationState.assigneesAdded = true;
      }

      // Fetch and verify the complete relationship state before reporting success.
      completeTask = createdTask.id
        ? await getTaskWithRelationships(client, createdTask.id, {
            ...(args.labels !== undefined && { labels: args.labels }),
            ...(args.assignees !== undefined && { assignees: args.assignees }),
          })
        : createdTask;
      verifyRequestedRelationships(completeTask, args);
    } catch (updateError) {
      // Attempt to clean up the partially created task
      await rollbackTaskCreation(client, creationState, updateError);
      // The rollback function will re-throw the original error with context
    }

    // Place the task in a specific Kanban column if requested. Done after the
    // task exists (create ignores a bucket id) and outside the rollback block:
    // a placement failure is reported loudly but the created task is preserved
    // in its default column rather than deleted.
    const requestedBucketId = args.bucketId ?? args.bucket_id;
    if (requestedBucketId !== undefined && createdTask.id !== undefined && args.projectId !== undefined) {
      await placeTaskInBucket(
        client,
        args.projectId,
        requestedBucketId,
        createdTask.id,
        args.viewId ?? args.view_id,
      );
    }

    const response = createTaskResponse(
      'create-task',
      'Task created successfully',
      { task: completeTask },
      {
        timestamp: new Date().toISOString(),
        ...(completeTask.id !== undefined && { taskId: completeTask.id }),
        projectId: args.projectId,
        labelsAdded: args.labels ? args.labels.length > 0 : false,
        assigneesAdded: args.assignees ? args.assignees.length > 0 : false,
      },
      undefined, // verbosity (ignored - using standard AORP)
      undefined, // useOptimizedFormat (ignored - using standard AORP)
      undefined, // useAorp (ignored - always using AORP)
      undefined, // aorpConfig (using auto-generated)
      args.sessionId
    );

    logger.debug('Tasks tool response', {
      subcommand: 'create',
      taskId: completeTask.id,
    });

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
      throw handleFetchError(error, 'create task');
    }

    // Use standardized error transformation for all other errors
    throw transformApiError(error, 'Failed to create task');
  }
}

/**
 * Move a freshly created task into a specific Kanban bucket. Vikunja ignores a
 * bucket id supplied on task creation, so we create first and then move via the
 * bucket-tasks endpoint (the same verified path the kanban tool uses), then
 * re-read the board to confirm the task actually landed — placement has been
 * silently dropped before.
 */
async function placeTaskInBucket(
  client: VikunjaClient,
  projectId: number,
  bucketId: number,
  taskId: number,
  viewId: number | undefined,
): Promise<void> {
  const service = client.tasks;
  const resolvedViewId = viewId ?? (await resolveKanbanViewId(service, projectId));

  try {
    await moveTaskToBucket(service, projectId, resolvedViewId, bucketId, taskId);
  } catch (error) {
    throw new MCPError(
      ErrorCode.API_ERROR,
      `Task ${taskId} was created in project ${projectId} but could not be moved to bucket ${bucketId}: ` +
        `${error instanceof Error ? error.message : String(error)}. It remains in the default column.`,
    );
  }

  // Confirm the move took. A read failure here is best-effort (the move call
  // itself succeeded), but a read that shows the task elsewhere is a real
  // silent-drop and must surface.
  let landed: boolean;
  try {
    const buckets = await getBucketsForView(service, projectId, resolvedViewId);
    landed = buckets.some((b) => b.id === bucketId && (b.tasks ?? []).some((t) => t.id === taskId));
  } catch {
    return;
  }
  if (!landed) {
    throw new MCPError(
      ErrorCode.API_ERROR,
      `Task ${taskId} was created but did not land in bucket ${bucketId} after the move. It remains in the default column.`,
    );
  }
}

async function resolveKanbanViewId(service: TaskService, projectId: number): Promise<number> {
  const views = (await getProjectViews(service, projectId)) ?? [];
  const kanban = views.find((v) => v.view_kind === 'kanban');
  if (!kanban) {
    throw new MCPError(ErrorCode.NOT_FOUND, `Project ${projectId} has no Kanban view`);
  }
  return kanban.id;
}

function verifyRequestedRelationships(task: Task, args: CreateTaskArgs): void {
  if (args.labels !== undefined) {
    verifyIds(task.id, 'labels', args.labels, task.labels?.map((label) => label.id) ?? []);
  }
  if (args.assignees !== undefined) {
    verifyIds(task.id, 'assignees', args.assignees, task.assignees?.map((assignee) => assignee.id) ?? []);
  }
}

function verifyIds(
  taskId: number | undefined,
  relationship: 'labels' | 'assignees',
  requestedIds: number[],
  actualIds: Array<number | undefined>,
): void {
  const expected = [...requestedIds].sort((a, b) => a - b);
  const actual = actualIds
    .filter((id): id is number => id !== undefined)
    .sort((a, b) => a - b);

  if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index])) {
    throw new MCPError(
      ErrorCode.API_ERROR,
      `Task ${taskId ?? 'unknown'} was created but requested ${relationship} were not applied`,
    );
  }
}

/**
 * Adds labels to a task with retry logic for authentication errors
 */
async function addLabelsToTask(client: VikunjaClient, taskId: number, labelIds: number[]): Promise<void> {
  try {
    await retryPostCreateRelationship(
      () => client.tasks.updateTaskLabels(taskId, {
        label_ids: labelIds,
      }),
    );
  } catch (labelError) {
    // Check if it's an auth error after retries
    if (isAuthenticationError(labelError)) {
      throw new MCPError(
        ErrorCode.API_ERROR,
        `${AUTH_ERROR_MESSAGES.LABEL_CREATE} (Retried ${RETRY_CONFIG.AUTH_ERRORS.maxRetries} times). Task ID: ${taskId}`,
      );
    }
    throw labelError;
  }
}

/**
 * Adds assignees to a task with retry logic for authentication errors
 */
async function addAssigneesToTask(client: VikunjaClient, taskId: number, assigneeIds: number[]): Promise<void> {
  try {
    await retryPostCreateRelationship(
      () => client.tasks.bulkAssignUsersToTask(taskId, {
        user_ids: assigneeIds,
      }),
    );
  } catch (assigneeError) {
    // Check if it's an auth error after retries
    if (isAuthenticationError(assigneeError)) {
      throw new MCPError(
        ErrorCode.API_ERROR,
        `${AUTH_ERROR_MESSAGES.ASSIGNEE_CREATE} (Retried ${RETRY_CONFIG.AUTH_ERRORS.maxRetries} times). Task ID: ${taskId}`,
      );
    }
    throw assigneeError;
  }
}

const POST_CREATE_RETRY_DELAYS_MS = [100, 250, 500];

async function retryPostCreateRelationship<T>(operation: () => Promise<T>): Promise<T> {
  for (const delayMs of POST_CREATE_RETRY_DELAYS_MS) {
    try {
      return await operation();
    } catch (error) {
      if (!isPostCreateRetryable(error)) {
        throw error;
      }

      await delay(delayMs);
    }
  }

  return operation();
}

function isPostCreateRetryable(error: unknown): boolean {
  if (isAuthenticationError(error)) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return /task does not exist|task not found/i.test(message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Attempts to roll back a partially created task and throws enhanced error context
 */
async function rollbackTaskCreation(
  client: VikunjaClient,
  creationState: CreationState,
  originalError: unknown
): Promise<never> {
  // Attempt to clean up the partially created task
  let rollbackSucceeded = false;
  if (creationState.createdTask.id) {
    try {
      await client.tasks.deleteTask(creationState.createdTask.id);
      rollbackSucceeded = true;
    } catch (deleteError) {
      // Log the cleanup failure but throw the original error
      logger.error('Failed to clean up partially created task:', deleteError);
    }
  }

  // Re-throw the original error with context
  const errorMessage = `Failed to complete task creation: ${originalError instanceof Error ? originalError.message : String(originalError)}. ${
    rollbackSucceeded
      ? 'Task was successfully rolled back.'
      : 'Task rollback also failed - manual cleanup may be required.'
  }`;

  throw new MCPError(ErrorCode.API_ERROR, errorMessage, {
    vikunjaError: {
      taskId: creationState.createdTask.id,
      partiallyCreated: true,
      labelsAdded: creationState.labelsAdded,
      assigneesAdded: creationState.assigneesAdded,
      rollbackSucceeded,
    },
  });
}
