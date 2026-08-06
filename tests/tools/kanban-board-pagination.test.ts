import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { registerKanbanTool } from '../../src/tools/kanban';
import { applyTaskServiceCompatibility } from '../../src/client/applyTaskServiceCompatibility';
import { getClientFromContext } from '../../src/client';
import type { TaskService } from 'node-vikunja';

jest.mock('../../src/client', () => ({
  getClientFromContext: jest.fn(),
  setGlobalClientFactory: jest.fn(),
}));

/**
 * Vikunja caps `per_page` at its configured maximum (50 by default) and
 * paginates the tasks *inside each bucket* of a Kanban board read, while
 * reporting each bucket's true row count in `count`. This fake reproduces
 * that: a column with more than one page of tasks hands back only a slice.
 */
const PAGE_CAP = 50;

interface FakeBoard {
  request: TaskService['request'];
  bucketOf(taskId: number): number | undefined;
}

function fakeBoard(initial: Record<number, number[]>): FakeBoard {
  const board = new Map<number, number[]>(
    Object.entries(initial).map(([id, taskIds]) => [Number(id), [...taskIds]]),
  );

  const request = jest.fn(
    async (
      endpoint: string,
      method: string,
      body?: unknown,
      options?: { params?: { page?: number; per_page?: number } },
    ): Promise<unknown> => {
      const move = /^\/projects\/\d+\/views\/\d+\/buckets\/(\d+)\/tasks$/.exec(endpoint);
      if (method === 'POST' && move) {
        const bucketId = Number(move[1]);
        const taskId = (body as { task_id: number }).task_id;
        for (const taskIds of board.values()) {
          const at = taskIds.indexOf(taskId);
          if (at !== -1) taskIds.splice(at, 1);
        }
        board.get(bucketId)?.push(taskId);
        return { task_id: taskId, bucket_id: bucketId };
      }

      if (method === 'GET' && /^\/projects\/\d+\/views\/\d+\/tasks$/.test(endpoint)) {
        const page = options?.params?.page ?? 1;
        const perPage = Math.min(options?.params?.per_page ?? PAGE_CAP, PAGE_CAP);
        return Array.from(board.entries()).map(([id, taskIds]) => ({
          id,
          title: `bucket-${id}`,
          count: taskIds.length,
          tasks: taskIds.slice((page - 1) * perPage, page * perPage).map((taskId) => ({ id: taskId })),
        }));
      }

      if (method === 'GET' && /^\/projects\/\d+\/views$/.test(endpoint)) {
        return [
          {
            id: 132,
            project_id: 32,
            title: 'Kanban',
            view_kind: 'kanban',
            default_bucket_id: 247,
            done_bucket_id: 249,
          },
        ];
      }

      if (method === 'GET' && /^\/projects\/\d+\/views\/\d+\/buckets$/.test(endpoint)) {
        return Array.from(board.entries()).map(([id, taskIds], index) => ({
          id,
          title: `bucket-${id}`,
          position: index,
          count: taskIds.length,
        }));
      }

      throw new Error(`unexpected request: ${method} ${endpoint}`);
    },
  ) as unknown as TaskService['request'];

  return {
    request,
    bucketOf(taskId: number): number | undefined {
      for (const [id, taskIds] of board) {
        if (taskIds.includes(taskId)) return id;
      }
      return undefined;
    },
  };
}

const range = (from: number, count: number): number[] =>
  Array.from({ length: count }, (_, i) => from + i);

describe('vikunja_kanban - a column holding more than one page of tasks', () => {
  let board: FakeBoard;
  let handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

  const authManager = { isAuthenticated: jest.fn().mockReturnValue(true) } as never;

  beforeEach(() => {
    jest.clearAllMocks();
    // 54 tasks already in the done column (249) — more than one page.
    board = fakeBoard({ 247: [900, 901, 902], 249: range(1, 54) });
    const service = { getAllTasks: jest.fn(), request: board.request } as unknown as TaskService;
    applyTaskServiceCompatibility(service);
    (getClientFromContext as jest.Mock).mockResolvedValue({ tasks: service });

    const server = { tool: jest.fn() };
    registerKanbanTool(server as never, authManager);
    handler = server.tool.mock.calls[0][3] as typeof handler;
  });

  it('verifies a move into a column whose first page is already full', async () => {
    const result = await handler({
      operation: 'move-task',
      projectId: 32,
      taskId: 900,
      intoBucketId: 249,
      viewId: 132,
    });

    // The write landed — the post-move verify must read past the first page
    // instead of calling a task it cannot see "in bucket none".
    expect(board.bucketOf(900)).toBe(249);
    expect(result.content[0].text).toBe('Moved task 900 to column 249 (verified)');
  });

  it('counts every task in a column, not just the first page', async () => {
    const result = await handler({ operation: 'list-buckets', projectId: 32, viewId: 132 });

    expect(result.content[0].text).toContain('| 249 | bucket-249 | 54 |');
  });
});
