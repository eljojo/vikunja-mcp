/**
 * Task Read Service
 * Handles task retrieval operations with comprehensive error handling
 */

import { MCPError, ErrorCode, getClientFromContext, transformApiError, handleFetchError, handleStatusCodeError } from '../../../index';
import { validateId } from '../validation';
import { createTaskResponse } from './TaskResponseFormatter';
import { formatAorpAsMarkdown } from '../../../utils/response-factory';
import { enrichTasksWithBucketIds } from '../../../client/applyTaskServiceCompatibility';
import { enrichTasksWithBucketTitles } from '../../../utils/task-display-enrichment';
import type { TaskComment } from '../../../types/vikunja';

export interface GetTaskArgs {
  id?: number;
  projectId?: number;
  viewId?: number;
  view_id?: number;
  /**
   * Return the task's stored fields verbatim (raw JSON) instead of the display
   * rendering. The rendered read HTML-strips and newline-flattens description
   * text, so it can't be round-tripped; `raw` is the read a cleanup/backfill
   * sweep needs to decode-and-rewrite a field without guessing its structure.
   */
  raw?: boolean;
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

    // Verbatim read: the stored task object, untouched — no HTML-strip, no
    // newline-flatten, no verbosity trimming — so a caller can read a field and
    // write it back without corrupting line breaks or decoding entities blind.
    if (args.raw) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Raw task ${args.id} (verbatim stored fields):\n\n\`\`\`json\n${JSON.stringify(task, null, 2)}\n\`\`\``,
          },
        ],
      };
    }

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

    // Resolve the kanban column so a get carries the same "Column" the project
    // list shows — the list does this for every card, so a get shouldn't be the
    // less-informative read. Best-effort: mutates in place, never fails the get.
    await enrichTasksWithBucketTitles(client.tasks, [enrichedTask]);

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

    let text = formatAorpAsMarkdown(response.response);

    // Single-task get includes comments: one extra call — cheap for one task, and comments
    // are the context you want when opening a card. (list does NOT do this — N calls would be
    // too heavy.) Degrade gracefully; never fail the whole get if the comments fetch fails.
    try {
      const comments = await client.tasks.getTaskComments(args.id);
      text += formatCommentsSection(comments);
    } catch {
      text += '\n\n_(comments unavailable)_';
    }

    return {
      content: [
        {
          type: 'text' as const,
          text,
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

function formatCommentsSection(comments: TaskComment[]): string {
  if (!comments || comments.length === 0) {
    return '\n\n### Comments (0)\n_No comments._';
  }
  const lines = comments.map((c) => {
    const who = c.author?.name || c.author?.username || 'unknown';
    const when = (c.created ?? '').slice(0, 16).replace('T', ' ');
    const body = (c.comment ?? '').replace(/<[^>]+>/g, '').trim();
    return `- **${who}** · ${when} — ${body}`;
  });
  return `\n\n### Comments (${comments.length})\n${lines.join('\n')}`;
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
