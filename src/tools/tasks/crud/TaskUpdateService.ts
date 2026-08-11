/**
 * Task Update Service
 * Handles task updates with field diffing and relationship management
 */

import { MCPError, ErrorCode } from '../../../types';
import { getClientFromContext } from '../../../client';
import type { Task, VikunjaClient } from 'node-vikunja';
import {
  validateDateString,
  isDateSet,
  resolveDueDate,
  validateId,
  convertRepeatConfiguration,
  buildWritableTaskSnapshot,
} from '../validation';
import { htmlToPlainText } from '../../../utils/html-text';
import { isAuthenticationError } from '../../../utils/auth-error-handler';
import { RETRY_CONFIG } from '../../../utils/retry';
import { transformApiError, handleFetchError, handleStatusCodeError } from '../../../utils/error-handler';
import { AUTH_ERROR_MESSAGES } from '../constants';
import { createTaskResponse } from './TaskResponseFormatter';
import { formatAorpAsMarkdown } from '../../../utils/response-factory';
import {
  getBucketsForView,
  getProjectViews,
  moveTaskToBucket,
  type ProjectViewLite,
} from '../../../client/applyTaskServiceCompatibility';

export interface UpdateTaskArgs {
  id?: number;
  projectId?: number;
  bucketId?: number;
  bucket_id?: number;
  viewId?: number;
  view_id?: number;
  title?: string;
  description?: string;
  /** `""` or `null` clears the due date. */
  dueDate?: string | null;
  priority?: number;
  done?: boolean;
  labels?: number[];
  assignees?: number[];
  repeatAfter?: number;
  repeatMode?: 'day' | 'week' | 'month' | 'year';
  /** How `description` is applied: wholesale (default), in place, or at the end. */
  editMode?: 'replace' | 'patch' | 'append';
  /** patch: the text to find in the stored description. */
  findText?: string;
  /** patch: what to put in the match's place (`""` deletes it). Also accepted
   *  as the text to append, when `description` is not the more natural place. */
  replaceText?: string;
  /** patch: replace every occurrence instead of refusing an ambiguous match. */
  replaceAll?: boolean;
  /** Echo the pre-update field values back. Off by default. */
  returnPrevious?: boolean;
  /** With `done: true`, also move the card to the board's done column (default true). */
  moveToDoneBucket?: boolean;
  // Session ID for AORP response tracking
  sessionId?: string;
}

/**
 * Internal interface for tracking update state and field changes
 */
interface UpdateState {
  currentTask: Task;
  previousState: Record<string, unknown>;
  affectedFields: string[];
}

/**
 * Updates a task with comprehensive field diffing and relationship management
 */
export async function updateTask(args: UpdateTaskArgs): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    if (!args.id) {
      throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Task id is required for update operation');
    }
    validateId(args.id, 'id');
    if (args.projectId !== undefined) {
      validateId(args.projectId, 'projectId');
    }
    const bucketId = resolveBucketId(args);
    if (bucketId !== undefined) {
      validateId(bucketId, 'bucketId');
    }
    const viewId = resolveViewId(args);
    if (viewId !== undefined) {
      validateId(viewId, 'viewId');
    }
    if (bucketId !== undefined && viewId === undefined) {
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        'viewId is required when moving a task to a bucket',
      );
    }

    // Validate date if provided. `""`/null mean "clear it", not "a bad date".
    if (isDateSet(args.dueDate)) {
      validateDateString(args.dueDate, 'dueDate');
    }

    const client = await getClientFromContext();

    // Analyze current state and track changes
    const updateState = await analyzeUpdateState(client, args.id, args);

    // Resolve what the description should become. A patch/append is computed
    // against the stored body we already fetched, so an in-place edit costs no
    // extra call and the caller never re-sends the whole description.
    const description = resolveDescription(updateState.currentTask.description ?? '', args);
    const effectiveArgs: UpdateTaskArgs =
      description === undefined ? args : { ...args, description };
    if (description !== undefined && description !== updateState.currentTask.description) {
      if (!updateState.affectedFields.includes('description')) {
        updateState.affectedFields.push('description');
      }
    }

    // Build and apply the update
    if (hasTaskFieldUpdates(effectiveArgs)) {
      const updateData = buildUpdateData(updateState.currentTask, effectiveArgs);
      await client.tasks.updateTask(args.id, updateData);
    }

    // Update labels if provided
    if (args.labels !== undefined) {
      await updateTaskLabels(client, args.id, args.labels);
    }

    // Update assignees if provided
    if (args.assignees !== undefined) {
      await updateTaskAssignees(client, args.id, args.assignees);
    }

    let movedBucketId: number | undefined;
    if (bucketId !== undefined && viewId !== undefined) {
      const projectId = args.projectId ?? updateState.currentTask.project_id;
      if (projectId === undefined) {
        throw new MCPError(
          ErrorCode.VALIDATION_ERROR,
          'projectId is required when the task response does not include a project',
        );
      }
      await moveTaskToBucket(
        client.tasks,
        projectId,
        viewId,
        bucketId,
        args.id,
      );
      await confirmTaskIsInBucket(client, projectId, viewId, bucketId, args.id);
      movedBucketId = bucketId;
    }

    // Closing a card should close it on the board too. Marking it done and
    // leaving it in "doing" is the state nobody wants and everybody forgets to
    // fix — and the board is read visually, so a half-closed card reads as open.
    const notes: string[] = [];
    if (args.done === true && movedBucketId === undefined && args.moveToDoneBucket !== false) {
      const doneMove = await moveToDoneColumn(
        client,
        args.id,
        args.projectId ?? updateState.currentTask.project_id,
        viewId,
      );
      if (doneMove.movedTo !== undefined) {
        movedBucketId = doneMove.movedTo;
        // The card changed column, so a caller diffing affectedFields sees it.
        if (!updateState.affectedFields.includes('bucketId')) {
          updateState.affectedFields.push('bucketId');
        }
        notes.push(`moved to the board's done column (bucket ${doneMove.movedTo})`);
      } else if (doneMove.note !== undefined) {
        notes.push(doneMove.note);
      }
    }

    // Fetch the complete updated task
    const fetchedTask = await client.tasks.getTask(args.id);
    const completeTask = movedBucketId === undefined
      ? fetchedTask
      : { ...fetchedTask, bucket_id: movedBucketId };
    if (args.projectId !== undefined && completeTask.project_id !== args.projectId) {
      throw new MCPError(
        ErrorCode.API_ERROR,
        `Task ${args.id} was not moved to project ${args.projectId}`,
      );
    }

    // Vikunja sanitizes rich text server-side, and the rendered read strips
    // HTML, so silent loss is invisible from either end. Compare against the
    // stored echo: different markup is normalisation, different PLAIN TEXT is
    // content that did not survive the save.
    const sentDescription = effectiveArgs.description;
    const storedDescription = fetchedTask?.description;
    if (
      sentDescription !== undefined &&
      storedDescription !== undefined &&
      storedDescription !== sentDescription &&
      htmlToPlainText(storedDescription) !== htmlToPlainText(sentDescription)
    ) {
      notes.push(
        'Vikunja stored a description whose text differs from what was sent — content was dropped or rewritten on save. ' +
          'Read it back with `get` and raw:true to see exactly what is stored.',
      );
    }

    const response = createTaskResponse(
      'update-task',
      'Task updated successfully',
      { task: completeTask },
      {
        timestamp: new Date().toISOString(),
        affectedFields: updateState.affectedFields,
        ...(args.returnPrevious === true && {
          previousState: updateState.previousState as Partial<Task>,
        }),
        ...(notes.length > 0 && { note: notes.join('; ') }),
        taskId: args.id,
      },
      undefined, // verbosity (ignored - using standard AORP)
      undefined, // useOptimizedFormat (ignored - using standard AORP)
      undefined, // useAorp (ignored - always using AORP)
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
      throw handleFetchError(error, 'update task');
    }

    // Use standardized error transformation for all other errors
    if (args.id) {
      throw handleStatusCodeError(error, 'update task', args.id, `Task with ID ${args.id} not found`);
    }
    throw transformApiError(error, 'Failed to update task');
  }
}

/**
 * Confirm a bucket move by reading the board back.
 *
 * The bucket-tasks endpoint echoes the bucket id it was handed, and a plain
 * task GET always reports bucket_id 0 (Vikunja only fills it when the task is
 * read through a view), so neither can tell us whether the task was seated.
 * Checking either one against the requested id is a guard that cannot fail.
 */
async function confirmTaskIsInBucket(
  client: VikunjaClient,
  projectId: number,
  viewId: number,
  bucketId: number,
  taskId: number,
): Promise<void> {
  let buckets;
  try {
    buckets = await getBucketsForView(client.tasks, projectId, viewId);
  } catch (error) {
    throw new MCPError(
      ErrorCode.API_ERROR,
      `Task ${taskId} was sent to bucket ${bucketId}, but the move could not be verified: ` +
        `reading view ${viewId} failed (${error instanceof Error ? error.message : String(error)}). ` +
        'Re-read the board before treating the move as done.',
    );
  }

  const seated = buckets.some(
    (bucket) => bucket.id === bucketId && (bucket.tasks ?? []).some((task) => task.id === taskId),
  );
  if (!seated) {
    throw new MCPError(
      ErrorCode.API_ERROR,
      `Task ${taskId} was not moved to bucket ${bucketId}`,
    );
  }
}

/** Escape prose that is about to be embedded in stored HTML. */
function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Work out the description to store, given the one already stored.
 *
 * Returns undefined when the caller isn't rewriting in place, which leaves
 * `description` to flow through untouched.
 *
 * `patch` matches against the RAW stored HTML and refuses rather than guessing:
 * a find that matches nothing, or matches several times without `replaceAll`,
 * is an error. A patch that reports success while writing nothing is the
 * failure mode this exists to avoid.
 */
function resolveDescription(stored: string, args: UpdateTaskArgs): string | undefined {
  if (args.editMode === undefined || args.editMode === 'replace') {
    return undefined;
  }

  if (args.editMode === 'append') {
    const addition = args.description ?? args.replaceText;
    if (addition === undefined || addition === '') {
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        'editMode "append" needs the text to append, in `description` (or `replaceText`)',
      );
    }
    // Vikunja stores rich text as HTML. Prose that isn't wrapped in a block
    // would be absorbed into the last one instead of starting a new paragraph
    // — and its `<` and `&` would be read as markup. Only treat the addition as
    // ready-made HTML when it actually STARTS with a block tag; anything else
    // is prose, and gets escaped and wrapped.
    const isHtmlBlock = /^\s*<(p|div|h[1-6]|ul|ol|li|blockquote|pre|table)\b/i.test(addition);
    return stored + (isHtmlBlock ? addition : `<p>${escapeHtmlText(addition)}</p>`);
  }

  // patch
  const findText = args.findText;
  if (findText === undefined || findText === '') {
    throw new MCPError(ErrorCode.VALIDATION_ERROR, 'editMode "patch" requires findText');
  }
  const replaceText = args.replaceText ?? args.description;
  if (replaceText === undefined) {
    throw new MCPError(
      ErrorCode.VALIDATION_ERROR,
      'editMode "patch" requires replaceText (pass "" to delete the matched text)',
    );
  }

  const occurrences = stored.split(findText).length - 1;
  if (occurrences === 0) {
    // Say WHY it missed. Vikunja stores HTML, so text copied out of a rendered
    // read has already lost its markup and entities and will never match.
    const foundInPlainText = htmlToPlainText(stored).includes(findText);
    throw new MCPError(
      ErrorCode.VALIDATION_ERROR,
      `editMode "patch" found no match for findText, so nothing was written. ` +
        (foundInPlainText
          ? 'The text IS present in the rendered description but not in the stored HTML — ' +
            'markup, entities or &nbsp; sit between the words. Read the stored form with ' +
            '`get` and raw:true, and patch against that.'
          : 'The text is not in this description at all. Read it with `get` and raw:true to see the stored form.'),
    );
  }
  if (occurrences > 1 && args.replaceAll !== true) {
    throw new MCPError(
      ErrorCode.VALIDATION_ERROR,
      `editMode "patch" found ${occurrences} matches for findText and will not guess which one you meant. ` +
        'Pass a longer findText, or replaceAll:true to change every one. Nothing was written.',
    );
  }

  // Split/join, not String.replace: replace() expands `$&`, `` $` `` and `$1` in
  // the REPLACEMENT string, so a description containing a literal `$&` would be
  // silently mangled. Splitting treats both sides as plain text.
  const parts = stored.split(findText);
  if (args.replaceAll === true) {
    return parts.join(replaceText);
  }
  return parts[0] + replaceText + parts.slice(1).join(findText);
}

/**
 * Move a task into its board's done column.
 *
 * Best-effort by design: the `done` write has already landed by the time this
 * runs, so a project with no Kanban view, no configured done column, or a
 * client that can't read views must not turn a successful update into a
 * failure. It reports what it did (or why it didn't) instead.
 */
async function moveToDoneColumn(
  client: VikunjaClient,
  taskId: number,
  projectId: number | undefined,
  requestedViewId: number | undefined,
): Promise<{ movedTo?: number; note?: string }> {
  if (projectId === undefined) {
    return {
      note: 'marked done, but the task response carried no project, so the board column could not be resolved',
    };
  }

  let view: ProjectViewLite | undefined;
  try {
    const views = (await getProjectViews(client.tasks, projectId)) ?? [];
    // An explicitly passed viewId names the board the caller means; otherwise
    // fall back to the project's Kanban view.
    view =
      requestedViewId !== undefined
        ? views.find((v) => v.id === requestedViewId)
        : views.find((v) => v.view_kind === 'kanban');
    if (!view) {
      return requestedViewId !== undefined
        ? { note: `marked done, but view ${requestedViewId} was not found in project ${projectId}, so the card did not move` }
        : { note: `marked done; project ${projectId} has no Kanban view, so there was no card to move` };
    }
  } catch (error) {
    return {
      note:
        `marked done, but project ${projectId}'s views could not be read ` +
        `(${error instanceof Error ? error.message : String(error)}), so the card was not moved`,
    };
  }

  const doneBucketId = view.done_bucket_id;
  if (doneBucketId === undefined || doneBucketId === 0) {
    return {
      note:
        `marked done, but project ${projectId}'s board has no done column configured, so the card did not move ` +
        '(set one with vikunja_kanban set-view-config)',
    };
  }

  // The write and the read-back are reported separately on purpose: a failed
  // verification does NOT mean the move failed, and saying it did would be the
  // same false claim this codebase already fixed once for explicit moves.
  try {
    await moveTaskToBucket(client.tasks, projectId, view.id, doneBucketId, taskId);
  } catch (error) {
    return {
      note:
        `marked done, but the move to done column ${doneBucketId} failed ` +
        `(${error instanceof Error ? error.message : String(error)}). The card is done and still in its old column.`,
    };
  }

  try {
    await confirmTaskIsInBucket(client, projectId, view.id, doneBucketId, taskId);
  } catch (error) {
    return {
      note:
        `marked done and sent to done column ${doneBucketId}, but the move could not be verified ` +
        `(${error instanceof Error ? error.message : String(error)}). Re-read the board before trusting the column.`,
    };
  }

  return { movedTo: doneBucketId };
}

/**
 * Analyzes the current task state and determines which fields are being updated
 */
async function analyzeUpdateState(client: VikunjaClient, taskId: number, args: UpdateTaskArgs): Promise<UpdateState> {
  // Fetch the current task to preserve all fields and track changes
  const currentTask = await client.tasks.getTask(taskId);
  const previousState: Record<string, unknown> = {};
  if (currentTask.title !== undefined) previousState.title = currentTask.title;
  if (currentTask.description !== undefined) previousState.description = currentTask.description;
  if (currentTask.due_date !== undefined) previousState.due_date = currentTask.due_date;
  if (currentTask.priority !== undefined) previousState.priority = currentTask.priority;
  if (currentTask.done !== undefined) previousState.done = currentTask.done;
  if (currentTask.repeat_after !== undefined) previousState.repeat_after = currentTask.repeat_after;
  if (currentTask.repeat_mode !== undefined) previousState.repeat_mode = currentTask.repeat_mode;
  if (currentTask.project_id !== undefined) previousState.project_id = currentTask.project_id;
  if (currentTask.bucket_id !== undefined) previousState.bucket_id = currentTask.bucket_id;

  // Track which fields are being updated
  const affectedFields: string[] = [];

  if (args.title !== undefined && args.title !== currentTask.title) affectedFields.push('title');
  if (args.description !== undefined && args.description !== currentTask.description) affectedFields.push('description');
  if (args.dueDate !== undefined && args.dueDate !== currentTask.due_date) affectedFields.push('dueDate');
  if (args.priority !== undefined && args.priority !== currentTask.priority) affectedFields.push('priority');
  if (args.done !== undefined && args.done !== currentTask.done) affectedFields.push('done');
  if (args.projectId !== undefined && args.projectId !== currentTask.project_id) affectedFields.push('projectId');
  const bucketId = resolveBucketId(args);
  if (bucketId !== undefined && bucketId !== currentTask.bucket_id) affectedFields.push('bucketId');
  if (args.repeatAfter !== undefined && args.repeatAfter !== currentTask.repeat_after) affectedFields.push('repeatAfter');
  if (args.repeatMode !== undefined && args.repeatMode !== currentTask.repeat_mode) affectedFields.push('repeatMode');
  if (args.labels !== undefined) affectedFields.push('labels');
  if (args.assignees !== undefined) affectedFields.push('assignees');

  return {
    currentTask,
    previousState,
    affectedFields
  };
}

/**
 * Builds the update data object by merging current task data with updates
 * This prevents the API from clearing fields that aren't explicitly updated
 */
function buildUpdateData(currentTask: Task, args: UpdateTaskArgs): Task {
  const bucketId = resolveBucketId(args);
  const updateData: Task = {
    ...buildWritableTaskSnapshot(currentTask),
    // Override with any provided updates
    ...(args.projectId !== undefined && { project_id: args.projectId }),
    ...(bucketId !== undefined && { bucket_id: bucketId }),
    ...(args.title !== undefined && { title: args.title }),
    ...(args.description !== undefined && { description: args.description }),
    ...(args.dueDate !== undefined && { due_date: resolveDueDate(args.dueDate) }),
    ...(args.priority !== undefined && { priority: args.priority }),
    ...(args.done !== undefined && { done: args.done }),
    // Handle repeat configuration for updates
    ...(args.repeatAfter !== undefined || args.repeatMode !== undefined
      ? ((): Record<string, unknown> => {
          const repeatConfig = convertRepeatConfiguration(
            args.repeatAfter !== undefined ? args.repeatAfter : currentTask.repeat_after,
            args.repeatMode !== undefined ? args.repeatMode : undefined,
          );
          const updates: Record<string, unknown> = {};
          if (repeatConfig.repeat_after !== undefined)
            updates.repeat_after = repeatConfig.repeat_after;
          if (repeatConfig.repeat_mode !== undefined) updates.repeat_mode = repeatConfig.repeat_mode;
          return updates;
        })()
      : {}),
  };

  return updateData;
}

function resolveBucketId(args: UpdateTaskArgs): number | undefined {
  if (
    args.bucketId !== undefined &&
    args.bucket_id !== undefined &&
    args.bucketId !== args.bucket_id
  ) {
    throw new MCPError(
      ErrorCode.VALIDATION_ERROR,
      'bucketId and bucket_id must match when both are provided',
    );
  }

  return args.bucketId ?? args.bucket_id;
}

function resolveViewId(args: UpdateTaskArgs): number | undefined {
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

function hasTaskFieldUpdates(args: UpdateTaskArgs): boolean {
  return [
    args.projectId,
    args.title,
    args.description,
    args.dueDate,
    args.priority,
    args.done,
    args.repeatAfter,
    args.repeatMode,
  ].some((value) => value !== undefined);
}

/**
 * Updates task labels with authentication error handling
 */
async function updateTaskLabels(client: VikunjaClient, taskId: number, labelIds: number[]): Promise<void> {
  try {
    await client.tasks.updateTaskLabels(taskId, {
      label_ids: labelIds,
    });
  } catch (labelError) {
    // Check if it's an auth error
    if (isAuthenticationError(labelError)) {
      throw new MCPError(ErrorCode.API_ERROR, AUTH_ERROR_MESSAGES.LABEL_UPDATE);
    }
    throw labelError;
  }
}

/**
 * Updates task assignees with diff calculation and authentication error handling
 */
async function updateTaskAssignees(client: VikunjaClient, taskId: number, newAssigneeIds: number[]): Promise<void> {
  try {
    // Get current assignees to calculate diff
    const currentTask = await client.tasks.getTask(taskId);
    const currentAssigneeIds = currentTask.assignees?.map((a) => a.id) || [];

    // Calculate which assignees to add and remove
    const toAdd = newAssigneeIds.filter((id: number) => !currentAssigneeIds.includes(id));
    const toRemove = currentAssigneeIds.filter((id: number) => !newAssigneeIds.includes(id));

    // Add new assignees first to avoid leaving task unassigned if removal fails
    if (toAdd.length > 0) {
      await client.tasks.bulkAssignUsersToTask(taskId, {
        user_ids: toAdd,
      });
    }

    // Remove old assignees only after new ones are successfully added
    for (const userId of toRemove) {
      try {
        await client.tasks.removeUserFromTask(taskId, userId);
      } catch (removeError) {
        // Check if it's an auth error on remove
        if (isAuthenticationError(removeError)) {
          throw new MCPError(ErrorCode.API_ERROR, AUTH_ERROR_MESSAGES.ASSIGNEE_REMOVE_PARTIAL);
        }
        throw removeError;
      }
    }
  } catch (assigneeError) {
    // Check if it's an auth error after retries
    if (isAuthenticationError(assigneeError)) {
      throw new MCPError(
        ErrorCode.API_ERROR,
        `${AUTH_ERROR_MESSAGES.ASSIGNEE_UPDATE} (Retried ${RETRY_CONFIG.AUTH_ERRORS.maxRetries} times)`
      );
    }
    throw assigneeError;
  }
}
