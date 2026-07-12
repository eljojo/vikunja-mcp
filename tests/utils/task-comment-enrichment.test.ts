import { describe, it, expect, jest } from '@jest/globals';
import { enrichTasksWithComments } from '../../src/utils/task-display-enrichment';
import { createSuccessResponse, formatMcpResponse } from '../../src/utils/simple-response';
import type { Task } from '../../src/types/vikunja';

type MockTaskService = { getTaskComments: jest.Mock };

function makeTask(id: number): Task {
  return { id, project_id: 3, title: `Task ${id}`, done: false };
}

describe('enrichTasksWithComments', () => {
  it('sets comment_count on every task but omits bodies without full', async () => {
    const service: MockTaskService = {
      getTaskComments: jest.fn(async (taskId: number) =>
        taskId === 1 ? [{ comment: 'a' }, { comment: 'b' }] : [],
      ),
    };
    const tasks = [makeTask(1), makeTask(2)];

    await enrichTasksWithComments(service as never, tasks);

    expect(tasks[0]!.comment_count).toBe(2);
    expect(tasks[1]!.comment_count).toBe(0);
    expect(tasks[0]!.comments).toBeUndefined();
  });

  it('attaches full comment bodies when full is requested (deep-read)', async () => {
    const service: MockTaskService = {
      getTaskComments: jest.fn(async () => [{ comment: 'the vegan note' }]),
    };
    const tasks = [makeTask(1)];

    await enrichTasksWithComments(service as never, tasks, { full: true });

    expect(tasks[0]!.comment_count).toBe(1);
    expect(tasks[0]!.comments).toEqual([{ comment: 'the vegan note' }]);
  });

  it('degrades gracefully when a task\'s comments cannot be read', async () => {
    const service: MockTaskService = {
      getTaskComments: jest.fn(async () => {
        throw new Error('boom');
      }),
    };
    const tasks = [makeTask(1)];

    await enrichTasksWithComments(service as never, tasks);

    // No count rather than a thrown error that would fail the whole list.
    expect(tasks[0]!.comment_count).toBeUndefined();
  });
});

describe('list rendering of comments', () => {
  function render(task: Task): string {
    const response = createSuccessResponse('list-tasks', 'Found 1 tasks', { tasks: [task] }, {});
    return formatMcpResponse(response)
      .map((c) => c.text)
      .join('\n');
  }

  it('shows a bare comment count so a card with hidden context is not invisible', () => {
    const text = render({ ...makeTask(710), comment_count: 3 });
    // A 💬 column carrying the count appears in the compact task table.
    expect(text).toContain('💬');
    const row = text.split('\n').find((l) => l.includes('Task 710'))!;
    expect(row).toContain('3');
  });

  it('renders full comment bodies below the table on a deep-read', () => {
    const text = render({ ...makeTask(710), comment_count: 1, comments: [{ comment: 'Amandine does not do vegan' }] });
    expect(text).toContain('💬 Task 710 (ID: 710) — 1 comment(s)');
    expect(text).toContain('Amandine does not do vegan');
  });

  it('shows nothing for a card with zero comments', () => {
    const text = render({ ...makeTask(711), comment_count: 0 });
    expect(text).not.toContain('💬');
  });
});
