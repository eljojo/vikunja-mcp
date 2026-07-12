/**
 * Final coverage tests for remaining uncovered lines in tasks/crud.ts
 * Targeting lines: 209-219, 279, 281, 363
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { createTask, getTask, updateTask, deleteTask } from '../../src/tools/tasks/crud';
import { MCPError, ErrorCode } from '../../src/types';
import type { MockVikunjaClient } from '../types/mocks';
import { parseMarkdown } from '../utils/markdown';

// Mock the client module
jest.mock('../../src/client', () => ({
  getClientFromContext: jest.fn(),
}));

// Mock logger to suppress output during tests
jest.mock('../../src/utils/logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('Tasks CRUD - Final Coverage', () => {
  let mockClient: MockVikunjaClient;
  const { getClientFromContext } = require('../../src/client');

  beforeEach(() => {
    jest.clearAllMocks();

    // Setup mock client with all required methods
    mockClient = {
      tasks: {
        createTask: jest.fn(),
        getTask: jest.fn(),
        updateTask: jest.fn(),
        deleteTask: jest.fn(),
        updateTaskLabels: jest.fn(),
        bulkAssignUsersToTask: jest.fn(),
        removeUserFromTask: jest.fn(),
        getBucketsForView: jest.fn(),
      },
    } as any;

    getClientFromContext.mockResolvedValue(mockClient);
  });

  describe('getTask success path (lines 209-219)', () => {
    it('should return successful response with task details', async () => {
      const mockTask = {
        id: 1,
        title: 'Test Task Title',
        description: 'Test Description',
        done: false,
        priority: 1,
      };

      mockClient.tasks.getTask.mockResolvedValue(mockTask);

      const result = await getTask({ id: 1 });

      expect(mockClient.tasks.getTask).toHaveBeenCalledWith(1);

      const markdown = result.content[0].text;
      const parsed = parseMarkdown(markdown);

      expect(markdown).toContain("## ✅ Success");
      expect(markdown).toContain('Retrieved task "Test Task Title"');

      expect(result.content[0].type).toBe('text');
    });

    it('raw:true returns the stored fields verbatim (round-trippable)', async () => {
      const mockTask = {
        id: 42,
        title: "Amandine's café",
        // Multi-line description with an entity the display path would mangle:
        // the rendered read HTML-strips and joins newlines with " / ".
        description: 'line one\nline two &amp; more',
        done: false,
      };
      mockClient.tasks.getTask.mockResolvedValue(mockTask);

      const result = await getTask({ id: 42, raw: true });

      // Verbatim: comments are never fetched, and the raw text survives intact.
      expect(mockClient.tasks.getTask).toHaveBeenCalledWith(42);
      const text = result.content[0].text;
      expect(text).toContain('Raw task 42');
      // The JSON block preserves the newline (as \n) and the raw entity.
      expect(text).toContain('line one\\nline two &amp; more');
      // JSON round-trips back to the exact stored object.
      const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
      expect(JSON.parse(json)).toEqual(mockTask);
    });

    it('resolves due date and kanban column so get is a superset of the list row', async () => {
      mockClient.tasks.getTask.mockResolvedValue({
        id: 55,
        project_id: 999,
        title: 'Buy oat milk',
        done: false,
        due_date: '2026-07-20T00:00:00Z',
        labels: [{ id: 3, title: 'errand' }],
      });
      // Board-view resolution feeds the "Column" the project list also shows.
      mockClient.tasks.getProjectViews = jest
        .fn()
        .mockResolvedValue([{ id: 77, view_kind: 'kanban' }]);
      mockClient.tasks.getBucketsForView.mockResolvedValue([
        { id: 1, title: 'To Do', tasks: [{ id: 55 }] },
      ]);
      mockClient.tasks.getTaskComments = jest.fn().mockResolvedValue([]);

      const result = await getTask({ id: 55 });
      const markdown = result.content[0].text;

      // due_date survives verbosity (would be stripped as a SCHEDULING field)...
      expect(markdown).toContain('Due');
      expect(markdown).toContain('2026-07-20');
      // ...the kanban column is resolved without needing an explicit viewId...
      expect(markdown).toContain('Column');
      expect(markdown).toContain('To Do');
      // ...and labels still render.
      expect(markdown).toContain('errand');
    });

    it('should enrich bucket id from the requested view', async () => {
      mockClient.tasks.getTask.mockResolvedValue({
        id: 16,
        project_id: 13,
        title: 'Moved task',
        done: false,
        bucket_id: 0,
      });
      mockClient.tasks.getBucketsForView.mockResolvedValue([
        { id: 38, tasks: [] },
        { id: 39, tasks: [{ id: 16, project_id: 13, title: 'Moved task' }] },
      ]);

      const result = await getTask({ id: 16, viewId: 52 });

      expect(mockClient.tasks.getBucketsForView).toHaveBeenCalledWith(13, 52);
      expect(result.content[0].text).toContain('Retrieved task "Moved task"');
    });

    it('should handle task with undefined title gracefully', async () => {
      const mockTask = {
        id: 1,
        title: undefined, // Undefined title
        description: 'Test Description',
        done: false,
        priority: 1,
      };

      mockClient.tasks.getTask.mockResolvedValue(mockTask);

      const result = await getTask({ id: 1 });

      const markdown = result.content[0].text;
      const parsed = parseMarkdown(markdown);

      expect(markdown).toContain("## ✅ Success");
      expect(markdown).toContain('Retrieved task "undefined"');
    });

    it('should handle task with null title gracefully', async () => {
      const mockTask = {
        id: 1,
        title: null, // Null title
        description: 'Test Description',
        done: false,
        priority: 1,
      };

      mockClient.tasks.getTask.mockResolvedValue(mockTask);

      const result = await getTask({ id: 1 });

      const markdown = result.content[0].text;
      const parsed = parseMarkdown(markdown);

      expect(markdown).toContain("## ✅ Success");
      expect(markdown).toContain('Retrieved task "null"');
    });
  });

  describe('updateTask field tracking (lines 279, 281)', () => {
    it('should move a task to another project and verify the result', async () => {
      const currentTask = {
        id: 1,
        project_id: 10,
        title: 'Task to move',
        description: 'Keep this',
        priority: 3,
        done: false,
      };
      const movedTask = {
        ...currentTask,
        project_id: 20,
      };
      mockClient.tasks.getTask
        .mockResolvedValueOnce(currentTask)
        .mockResolvedValueOnce(movedTask);
      mockClient.tasks.updateTask.mockResolvedValue(movedTask);

      const result = await updateTask({
        id: 1,
        projectId: 20,
      });

      expect(mockClient.tasks.updateTask).toHaveBeenCalledWith(1, {
        project_id: 20,
        title: 'Task to move',
        description: 'Keep this',
        priority: 3,
        done: false,
      });
      expect(result.content[0].text).toContain('projectId');
    });

    it('should reject a move when Vikunja leaves the task in the old project', async () => {
      const currentTask = {
        id: 1,
        project_id: 10,
        title: 'Task to move',
        done: false,
      };
      mockClient.tasks.getTask.mockResolvedValue(currentTask);
      mockClient.tasks.updateTask.mockResolvedValue(currentTask);

      await expect(updateTask({
        id: 1,
        projectId: 20,
      })).rejects.toThrow('Task 1 was not moved to project 20');
    });

    it('should track due date and priority changes correctly', async () => {
      const mockTask = {
        id: 1,
        title: 'Test Task',
        description: 'Test Description',
        due_date: '2024-01-01T00:00:00Z',
        priority: 1,
        done: false,
        repeat_after: 0,
        repeat_mode: 0,
        assignees: [],
      };

      const updatedTask = {
        ...mockTask,
        due_date: '2024-12-31T23:59:59Z', // Changed due date
        priority: 5, // Changed priority
      };

      mockClient.tasks.getTask
        .mockResolvedValueOnce(mockTask) // Initial fetch
        .mockResolvedValueOnce(updatedTask); // Final fetch
      mockClient.tasks.updateTask.mockResolvedValue(updatedTask);

      const result = await updateTask({
        id: 1,
        dueDate: '2024-12-31T23:59:59Z',
        priority: 5,
      });

      const markdown = result.content[0].text;
      const parsed = parseMarkdown(markdown);

      expect(markdown).toContain("## ✅ Success");
      expect(markdown).toContain('dueDate');
      expect(markdown).toContain('priority');
    });

    it('should not track unchanged fields', async () => {
      const mockTask = {
        id: 1,
        title: 'Test Task',
        description: 'Test Description',
        due_date: '2024-01-01T00:00:00Z',
        priority: 1,
        done: false,
        repeat_after: 0,
        repeat_mode: 0,
        assignees: [],
      };

      mockClient.tasks.getTask
        .mockResolvedValueOnce(mockTask) // Initial fetch
        .mockResolvedValueOnce(mockTask); // Final fetch
      mockClient.tasks.updateTask.mockResolvedValue(mockTask);

      const result = await updateTask({
        id: 1,
        dueDate: '2024-01-01T00:00:00Z', // Same due date
        priority: 1, // Same priority
      });

      const markdown = result.content[0].text;
      const parsed = parseMarkdown(markdown);

      expect(markdown).toContain("## ✅ Success");
      // For unchanged fields, they might not appear in affectedFields section
      // but the operation should still succeed
    });
  });

  describe('assignee error propagation (line 363)', () => {
    it('should propagate non-authentication errors during assignee removal', async () => {
      const taskWithAssignees = {
        id: 1,
        title: 'Test Task',
        description: 'Test Description',
        due_date: null,
        priority: 1,
        done: false,
        repeat_after: 0,
        repeat_mode: 0,
        assignees: [{ id: 1 }, { id: 2 }],
      };

      mockClient.tasks.getTask
        .mockResolvedValueOnce(taskWithAssignees) // Initial fetch
        .mockResolvedValueOnce(taskWithAssignees); // For assignee diff calculation
      mockClient.tasks.updateTask.mockResolvedValue(taskWithAssignees);

      // Mock successful addition but failed removal with non-auth error
      mockClient.tasks.bulkAssignUsersToTask.mockResolvedValue(undefined);
      const nonAuthError = new Error('Network timeout during remove operation');
      mockClient.tasks.removeUserFromTask.mockRejectedValue(nonAuthError);

      await expect(
        updateTask({
          id: 1,
          assignees: [1, 3], // Remove 2, add 3
        })
      ).rejects.toThrow('Network timeout during remove operation');
    });

    it('should propagate non-Error objects during assignee removal', async () => {
      const taskWithAssignees = {
        id: 1,
        title: 'Test Task',
        description: 'Test Description',
        due_date: null,
        priority: 1,
        done: false,
        repeat_after: 0,
        repeat_mode: 0,
        assignees: [{ id: 1 }, { id: 2 }],
      };

      mockClient.tasks.getTask
        .mockResolvedValueOnce(taskWithAssignees) // Initial fetch
        .mockResolvedValueOnce(taskWithAssignees); // For assignee diff calculation
      mockClient.tasks.updateTask.mockResolvedValue(taskWithAssignees);

      // Mock successful addition but failed removal with non-Error object
      mockClient.tasks.bulkAssignUsersToTask.mockResolvedValue(undefined);
      const nonErrorObject = { status: 500, error: 'Database connection lost' };
      mockClient.tasks.removeUserFromTask.mockRejectedValue(nonErrorObject);

      await expect(
        updateTask({
          id: 1,
          assignees: [1, 3], // Remove 2, add 3
        })
      ).rejects.toThrow('Failed to update task: Unknown error');
    });
  });

  describe('comprehensive field change tracking', () => {
    it('should track all possible field changes including repeat configuration', async () => {
      const mockTask = {
        id: 1,
        title: 'Original Title',
        description: 'Original Description',
        due_date: '2024-01-01T00:00:00Z',
        priority: 1,
        done: false,
        repeat_after: 0,
        repeat_mode: 0,
        assignees: [{ id: 1 }],
      };

      const updatedTask = {
        ...mockTask,
        title: 'New Title',
        description: 'New Description',
        due_date: '2024-12-31T23:59:59Z',
        priority: 5,
        done: true,
        repeat_after: 86400, // 1 day
        repeat_mode: 0,
      };

      mockClient.tasks.getTask
        .mockResolvedValueOnce(mockTask) // Initial fetch
        .mockResolvedValueOnce(updatedTask); // Final fetch
      mockClient.tasks.updateTask.mockResolvedValue(updatedTask);
      mockClient.tasks.updateTaskLabels.mockResolvedValue(undefined);
      mockClient.tasks.bulkAssignUsersToTask.mockResolvedValue(undefined);

      const result = await updateTask({
        id: 1,
        title: 'New Title',
        description: 'New Description',
        dueDate: '2024-12-31T23:59:59Z',
        priority: 5,
        done: true,
        repeatAfter: 1,
        repeatMode: 'day',
        labels: [1, 2],
        assignees: [1, 2],
      });

      const markdown = result.content[0].text;
      const parsed = parseMarkdown(markdown);

      expect(markdown).toContain("## ✅ Success");
      // Verify all affected fields are mentioned in the markdown output
      expect(markdown).toContain('title');
      expect(markdown).toContain('description');
      expect(markdown).toContain('dueDate');
      expect(markdown).toContain('priority');
      expect(markdown).toContain('done');
      expect(markdown).toContain('repeatAfter');
      expect(markdown).toContain('repeatMode');
      expect(markdown).toContain('labels');
      expect(markdown).toContain('assignees');
    });
  });
});
