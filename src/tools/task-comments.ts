/**
 * Task Comments Tool
 * Handles task comment operations: comment
 * Replaces monolithic tasks tool with focused individual tool
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthManager } from '../auth/AuthManager';
import type { VikunjaClientFactory } from '../client/VikunjaClientFactory';
import { MCPError, ErrorCode } from '../types';
import { getClientFromContext, setGlobalClientFactory } from '../client';
import { logger } from '../utils/logger';
import { createAuthRequiredError } from '../utils/error-handler';
import { handleComment, listComments, handleUpdateComment } from '../tools/tasks/comments/index';

/**
 * Register task comments tool
 */
export function registerTaskCommentsTool(
  server: McpServer,
  authManager: AuthManager,
  clientFactory?: VikunjaClientFactory
): void {
  server.tool(
    'vikunja_task_comments',
    'Manage task comments: list a task\'s comments (operation "list"), add one (operation "comment", also accepted as "create"), or edit one (operation "update", needs commentId). The task is addressed as `id`, and `taskId` is accepted as an alias.',
    {
      // `create` is an alias for `comment` — it is what a caller reaches for
      // first, by analogy with every other tool here.
      operation: z.enum(['comment', 'create', 'list', 'update']),
      // Task and comment identification. `id` is the task; `taskId` is an alias
      // for it, so neither is required on its own.
      id: z.number().optional(),
      taskId: z.number().optional(),
      comment: z.string().optional(),
      commentId: z.number().optional(),
    },
    async (args) => {
      try {
        // Check authentication
        if (!authManager.isAuthenticated()) {
          throw createAuthRequiredError('access task comment operations');
        }

        // Set the client factory for this request if provided
        if (clientFactory) {
          await setGlobalClientFactory(clientFactory);
        }

        // Test client connection
        await getClientFromContext();

        // `taskId` is an alias for `id`: every comment service downstream reads `id`.
        if (args.id === undefined && args.taskId !== undefined) {
          args.id = args.taskId;
        }

        logger.debug('Executing task comments tool', { operation: args.operation, taskId: args.id });

        // The services take only these; build the object explicitly so an
        // absent id stays absent (exactOptionalPropertyTypes).
        const commentArgs = {
          ...(args.id !== undefined && { id: args.id }),
          ...(args.comment !== undefined && { comment: args.comment }),
          ...(args.commentId !== undefined && { commentId: args.commentId }),
        };

        switch (args.operation) {
          case 'comment':
          case 'create':
            return handleComment(commentArgs);

          case 'list':
            return listComments(commentArgs);

          case 'update':
            return handleUpdateComment(commentArgs);

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
          `Task comment operation error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );
}