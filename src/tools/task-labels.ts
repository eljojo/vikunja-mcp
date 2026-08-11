/**
 * Task Labels Tool
 * Handles task label operations: apply-label, remove-label, list-labels
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
import { applyLabels, removeLabels, listTaskLabels, bulkTaskLabels } from '../tools/tasks/labels';

/**
 * Register task labels tool
 */
export function registerTaskLabelsTool(
  server: McpServer,
  authManager: AuthManager,
  clientFactory?: VikunjaClientFactory
): void {
  server.tool(
    'vikunja_task_labels',
    'Manage task labels: apply, remove, list labels; bulk-apply/remove across many tasks. The short verbs `apply`/`remove`/`list` are accepted alongside the hyphenated names.',
    {
      // Short verbs are aliases for the hyphenated names — `list` is what a
      // caller tries first, and the error message was the only teacher.
      operation: z.enum([
        'apply-label',
        'apply',
        'remove-label',
        'remove',
        'list-labels',
        'list',
        'bulk-apply-label',
        'bulk-remove-label',
      ]),
      // Task and label identification. `id` targets a single task; `taskIds` targets many
      // for the bulk operations.
      id: z.number().optional(),
      taskIds: z.array(z.number()).optional(),
      labels: z.array(z.number()).optional(),
    },
    async (args) => {
      try {
        logger.debug('Executing task labels tool', { operation: args.operation, taskId: args.id, labelCount: args.labels?.length });

        // Check authentication
        if (!authManager.isAuthenticated()) {
          throw createAuthRequiredError('access task label operations');
        }

        // Set the client factory for this request if provided
        if (clientFactory) {
          await setGlobalClientFactory(clientFactory);
        }

        // Test client connection
        await getClientFromContext();

        switch (args.operation) {
          case 'apply-label':
          case 'apply':
            return applyLabels({
              id: args.id,
              labels: args.labels || []
            });

          case 'remove-label':
          case 'remove':
            return removeLabels({
              id: args.id,
              labels: args.labels || []
            });

          case 'list-labels':
          case 'list':
            return listTaskLabels(args);

          case 'bulk-apply-label':
          case 'bulk-remove-label':
            return bulkTaskLabels({
              operation: args.operation,
              taskIds: args.taskIds || [],
              labels: args.labels || [],
            });

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
          `Task label operation error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );
}