/**
 * Simplified bulk operations for tasks (~250 lines)
 * Consolidates BulkOperationProcessor, BulkOperationErrorHandler, BulkOperationValidator, and BatchProcessorFactory
 */

import { MCPError, ErrorCode, createStandardResponse, getClientFromContext, logger, isAuthenticationError, RETRY_CONFIG, transformApiError, handleFetchError } from '../../index';
import type { Assignee } from '../../types';
import { withRetry } from '../../utils/retry';
import { BatchProcessor } from '../../utils/performance/batch-processor';
import type { Task } from 'node-vikunja';
import { convertRepeatConfiguration, applyFieldUpdate, buildWritableTaskSnapshot } from './validation';
import { formatAorpAsMarkdown } from '../../utils/response-factory';
import { AUTH_ERROR_MESSAGES, REPEAT_MODE_MAP } from './constants';
import { bulkOperationValidator } from './bulk/BulkOperationValidator';
import type { BulkUpdateArgs, BulkDeleteArgs, BulkCreateArgs, BulkCreateTaskData } from './bulk/BulkOperationValidator';
import { resolveViewId } from './bulk/BulkOperationValidator';
import { moveTaskToBucket } from '../../client/applyTaskServiceCompatibility';

// ==================== BATCH PROCESSORS ====================

const processors = {
  update: new BatchProcessor({ maxConcurrency: 5, batchSize: 10, enableMetrics: true, batchDelay: 0 }),
  delete: new BatchProcessor({ maxConcurrency: 3, batchSize: 5, enableMetrics: true, batchDelay: 100 }),
  create: new BatchProcessor({ maxConcurrency: 8, batchSize: 15, enableMetrics: true, batchDelay: 0 }),
};

// ==================== VALIDATION WRAPPERS ====================

// Re-use validation logic from BulkOperationValidator to eliminate duplication
const validateBulkUpdate = (args: BulkUpdateArgs): void => {
  bulkOperationValidator.validateBulkUpdate(args);
  bulkOperationValidator.preprocessFieldValue(args);
  bulkOperationValidator.validateFieldConstraints(args);
};

const validateBulkCreate = (args: BulkCreateArgs): void => bulkOperationValidator.validateBulkCreate(args);
const validateBulkDelete = (args: BulkDeleteArgs): void => bulkOperationValidator.validateBulkDelete(args);

// Re-export types for backward compatibility
export type { BulkUpdateArgs, BulkDeleteArgs, BulkCreateArgs, BulkCreateTaskData };

// ==================== RESPONSE HELPERS ====================

interface SuccessResponse {
  content: Array<{ type: 'text'; text: string }>;
}

const successResponse = (op: string, msg: string, tasks: Task[], meta: Record<string, unknown>): SuccessResponse => ({
  content: [{ type: 'text' as const, text: formatAorpAsMarkdown(createStandardResponse(op, msg, { tasks }, { timestamp: new Date().toISOString(), ...meta })) }]
});

// ==================== BULK UPDATE ====================

export async function bulkUpdateTasks(args: BulkUpdateArgs): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    validateBulkUpdate(args);
    const taskIds = args.taskIds ?? [];
    const client = await getClientFromContext();

    const updateResult = await processors.update.processBatches(taskIds, async (taskId) => {
      const current = await client.tasks.getTask(taskId);

      if (args.field === 'assignees' && Array.isArray(args.value)) {
        const requestedIds = args.value as number[];
        const currentIds = current.assignees?.map((assignee: Assignee) => assignee.id) ?? [];
        const toAdd = requestedIds.filter((id) => !currentIds.includes(id));
        const toRemove = currentIds.filter((id) => !requestedIds.includes(id));

        if (toAdd.length > 0) {
          try {
            await withRetry(
              () => client.tasks.bulkAssignUsersToTask(taskId, { user_ids: toAdd }),
              { ...RETRY_CONFIG.AUTH_ERRORS, shouldRetry: isAuthenticationError },
            );
          } catch (assigneeError) {
            if (isAuthenticationError(assigneeError)) {
              throw new MCPError(ErrorCode.API_ERROR, 'Assignee operations may have authentication issues');
            }
            throw assigneeError;
          }
        }

        for (const userId of toRemove) {
          try {
            await withRetry(
              () => client.tasks.removeUserFromTask(taskId, userId),
              { ...RETRY_CONFIG.AUTH_ERRORS, shouldRetry: isAuthenticationError },
            );
          } catch (error) {
            if (isAuthenticationError(error)) {
              throw new MCPError(
                ErrorCode.API_ERROR,
                `${AUTH_ERROR_MESSAGES.ASSIGNEE_REMOVE_PARTIAL} (Retried ${RETRY_CONFIG.AUTH_ERRORS.maxRetries} times)`,
              );
            }
            throw error;
          }
        }
      } else if (args.field === 'labels' && Array.isArray(args.value)) {
        await withRetry(
          () => client.tasks.updateTaskLabels(taskId, { label_ids: args.value as number[] }),
          { ...RETRY_CONFIG.AUTH_ERRORS, shouldRetry: isAuthenticationError },
        );
      } else if (args.field === 'bucket_id') {
        const viewId = resolveViewId(args);
        const projectId = current.project_id;
        if (viewId === undefined || projectId === undefined) {
          throw new MCPError(
            ErrorCode.VALIDATION_ERROR,
            'viewId and the task project are required for bucket moves',
          );
        }
        const relation = await moveTaskToBucket(
          client.tasks,
          projectId,
          viewId,
          args.value as number,
          taskId,
        );
        return {
          ...current,
          ...(relation.task ?? {}),
          bucket_id: relation.bucket_id,
        };
      } else {
        const updateValue = args.field === 'repeat_mode' && typeof args.value === 'string'
          ? (REPEAT_MODE_MAP[args.value] ?? args.value)
          : args.value;
        const update = applyFieldUpdate(
          buildWritableTaskSnapshot(current),
          args.field,
          updateValue,
        );
        await client.tasks.updateTask(taskId, update);
      }

      const updated = await client.tasks.getTask(taskId);
      verifyBulkUpdate(updated, args.field, args.value);
      return updated;
    });

    if (updateResult.successful.length === 0) {
      const firstError = updateResult.failed[0]?.error;
      if (firstError instanceof MCPError && firstError.message.includes('authentication')) {
        throw firstError;
      }
      throw new MCPError(
        ErrorCode.API_ERROR,
        `Bulk update failed. Could not update any tasks. Failed IDs: ${updateResult.failed.map((failure) => failure.originalItem).join(', ')}`,
      );
    }

    const failedIds = updateResult.failed.map((failure) => failure.originalItem);
    const partialFailure = failedIds.length > 0;
    return successResponse(
      'update-task',
      partialFailure
        ? `Bulk update partially completed. Successfully updated ${updateResult.successful.length} tasks. Failed IDs: ${failedIds.join(', ')}`
        : `Successfully updated ${updateResult.successful.length} tasks`,
      updateResult.successful,
      {
        count: updateResult.successful.length,
        affectedFields: [args.field],
        success: !partialFailure,
        ...(partialFailure && { failedCount: failedIds.length, failedIds }),
        performanceMetrics: {
          totalDuration: updateResult.metrics.totalDuration,
          operationsPerSecond: updateResult.metrics.operationsPerSecond,
          apiCallsUsed: updateResult.metrics.successfulOperations + updateResult.metrics.failedOperations,
        },
      },
    );
  } catch (error) {
    if (error instanceof MCPError) throw error;
    if (error instanceof Error && (error.message.includes('fetch failed') || error.message.includes('ECONNREFUSED') || error.message.includes('ENOTFOUND'))) throw handleFetchError(error, 'bulk update tasks');
    throw transformApiError(error, 'Failed to bulk update tasks');
  }
}

function verifyBulkUpdate(task: Task, field: string | undefined, requestedValue: unknown): void {
  if (!field) return;

  if (field === 'labels' || field === 'assignees') {
    const actualIds = (task[field] ?? []).map((item: { id?: number }) => item.id).filter((id): id is number => id !== undefined).sort((a, b) => a - b);
    const expectedIds = [...(requestedValue as number[])].sort((a, b) => a - b);
    if (actualIds.length !== expectedIds.length || actualIds.some((id, index) => id !== expectedIds[index])) {
      throw new MCPError(ErrorCode.API_ERROR, `Task ${task.id ?? 'unknown'} ${field} update could not be verified`);
    }
    return;
  }

  const expectedValue = field === 'repeat_mode' && typeof requestedValue === 'string'
    ? (REPEAT_MODE_MAP[requestedValue] ?? requestedValue)
    : requestedValue;
  if ((task as Record<string, unknown>)[field] !== expectedValue) {
    throw new MCPError(ErrorCode.API_ERROR, `Task ${task.id ?? 'unknown'} ${field} update could not be verified`);
  }
}

// ==================== BULK DELETE ====================

export async function bulkDeleteTasks(args: BulkDeleteArgs): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    validateBulkDelete(args);
    // Validation ensures taskIds exists
    const taskIds = args.taskIds ?? [];
    const client = await getClientFromContext();

    const fetchResult = await processors.delete.processBatches(taskIds, async (id) => await client.tasks.getTask(id));
    const deletionResult = await processors.delete.processBatches(taskIds, async (id) => { await client.tasks.deleteTask(id); return { taskId: id, deleted: true }; });

    if (deletionResult.failed.length > 0) {
      const failedIds = deletionResult.failed.map(f => f.originalItem);
      if (deletionResult.successful.length > 0) {
        return successResponse('delete-task', `Bulk delete partially completed. Successfully deleted ${deletionResult.successful.length} tasks. Failed to delete task IDs: ${failedIds.join(', ')}`, [], {
          count: deletionResult.successful.length, failedCount: deletionResult.failed.length, failedIds, previousState: fetchResult.successful, success: false,
        });
      }
      throw new MCPError(ErrorCode.API_ERROR, `Bulk delete failed. Could not delete any tasks. Failed IDs: ${failedIds.join(', ')}`);
    }

    return successResponse('delete-task', `Successfully deleted ${taskIds.length} tasks`, [], { count: taskIds.length, deletedTaskIds: taskIds, previousState: fetchResult.successful });
  } catch (error) {
    if (error instanceof MCPError) throw error;
    if (error instanceof Error && (error.message.includes('fetch failed') || error.message.includes('ECONNREFUSED') || error.message.includes('ENOTFOUND'))) throw handleFetchError(error, 'bulk delete tasks');
    throw transformApiError(error, 'Failed to bulk delete tasks');
  }
}

// ==================== BULK CREATE ====================

export async function bulkCreateTasks(args: BulkCreateArgs): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    validateBulkCreate(args);
  } catch (error) {
    // Preserve validation errors
    if (error instanceof MCPError) throw error;
    throw error;
  }

  try {
    const client = await getClientFromContext();
    // Validation ensures projectId and tasks exist
    const projectId = args.projectId ?? 0;
    const tasks = args.tasks ?? [];

    const creationResult = await processors.create.processBatches(
      tasks.map((_, i) => i),
      async (index) => {
        const t = tasks[index];
        if (!t) throw new Error(`Task data at index ${index} is undefined`);

        const newTask: Task = { title: t.title, project_id: projectId };
        if (t.description !== undefined) newTask.description = t.description;
        if (t.dueDate !== undefined) newTask.due_date = t.dueDate;
        if (t.priority !== undefined) newTask.priority = t.priority;
        if (t.repeatAfter !== undefined || t.repeatMode !== undefined) {
          const rc = convertRepeatConfiguration(t.repeatAfter, t.repeatMode);
          if (rc.repeat_after !== undefined) newTask.repeat_after = rc.repeat_after;
          if (rc.repeat_mode !== undefined) (newTask as Record<string, unknown>).repeat_mode = rc.repeat_mode;
        }

        const created = await client.tasks.createTask(projectId, newTask);
        if (!created.id) return created;

        // Narrow type - id is guaranteed to exist after early return
        const createdId = created.id;

        try {
          const labels = t.labels;
          if (labels && labels.length > 0) await withRetry(() => client.tasks.updateTaskLabels(createdId, { label_ids: labels }), { maxRetries: RETRY_CONFIG.AUTH_ERRORS.maxRetries ?? 3, timeout: (RETRY_CONFIG.AUTH_ERRORS.initialDelay ?? 1000) + (RETRY_CONFIG.AUTH_ERRORS.maxDelay ?? 10000), shouldRetry: isAuthenticationError });
          const assignees = t.assignees;
          if (assignees && assignees.length > 0) {
            try {
              await withRetry(() => client.tasks.bulkAssignUsersToTask(createdId, { user_ids: assignees }), { maxRetries: RETRY_CONFIG.AUTH_ERRORS.maxRetries ?? 3, timeout: (RETRY_CONFIG.AUTH_ERRORS.initialDelay ?? 1000) + (RETRY_CONFIG.AUTH_ERRORS.maxDelay ?? 10000), shouldRetry: isAuthenticationError });
            } catch (assigneeError) {
              if (isAuthenticationError(assigneeError)) {
                throw new MCPError(ErrorCode.API_ERROR, 'Assignee operations may have authentication issues');
              }
              // Wrap assignee errors to distinguish from createTask errors
              if (assigneeError instanceof Error) {
                const wrappedError = new MCPError(ErrorCode.API_ERROR, assigneeError.message);
                (wrappedError as unknown as Record<string, unknown>).isLabelAssigneeError = true;
                throw wrappedError;
              }
              throw assigneeError;
            }
          }
          return await client.tasks.getTask(createdId);
        } catch (updateError) {
          // Clean up the created task since labels/assignees failed
          try { await client.tasks.deleteTask(createdId); } catch (deleteError) { logger.error('Cleanup failed', deleteError); }
          // Wrap label errors to distinguish from createTask errors
          if (updateError instanceof Error && !(updateError instanceof MCPError)) {
            const wrappedError = new MCPError(ErrorCode.API_ERROR, updateError.message);
            (wrappedError as unknown as Record<string, unknown>).isLabelAssigneeError = true;
            throw wrappedError;
          }
          throw updateError;
        }
      }
    );

    const failedTasks = creationResult.failed.map(f => ({ index: f.originalItem as number, error: f.error instanceof Error ? f.error.message : String(f.error) }));
    if (failedTasks.length > 0 && creationResult.successful.length === 0) {
      const firstError = creationResult.failed[0]?.error;
      // Preserve MCPError instances with auth messages or label/assignee marker
      if (firstError instanceof MCPError && (firstError.message.includes('authentication') || (firstError as unknown as Record<string, unknown>).isLabelAssigneeError === true)) throw firstError;
      // Transform all other errors (including API errors) into generic bulk create error
      throw new MCPError(ErrorCode.API_ERROR, `Bulk create failed. Could not create any tasks`);
    }

    return successResponse('create-tasks', failedTasks.length > 0 ? `Bulk create partially completed. Successfully created ${creationResult.successful.length} tasks, ${failedTasks.length} failed.` : `Successfully created ${creationResult.successful.length} tasks`, creationResult.successful, {
      count: creationResult.successful.length, success: failedTasks.length === 0, ...(failedTasks.length > 0 && { failedCount: failedTasks.length, failures: failedTasks }),
    });
  } catch (error) {
    // Preserve MCPError instances from validation
    if (error instanceof MCPError) throw error;
    // Preserve fetch/connection errors
    if (error instanceof Error && (error.message.includes('fetch failed') || error.message.includes('ECONNREFUSED') || error.message.includes('ENOTFOUND'))) {
      throw handleFetchError(error, 'bulk create tasks');
    }
    // Transform all other errors into generic bulk create error
    throw new MCPError(ErrorCode.API_ERROR, 'Bulk create failed. Could not create any tasks');
  }
}
