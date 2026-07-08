/**
 * Tests for simple-response task formatting
 * Task lists render as compact, per-project markdown tables with dynamic
 * columns; single detail fields live in the table cells, not per-item blocks.
 */

import { formatSuccessMessage, createSuccessResponse, createErrorResponse } from '../../src/utils/simple-response';
import type { Task } from '../../src/types/vikunja';

describe('simple-response - Task Formatting', () => {
  describe('formatSuccessMessage with tasks (grouped table)', () => {
    it('renders a task in a per-project table with dynamic columns', () => {
      const task: Task = {
        id: 1,
        project_id: 5,
        project_title: 'Backend',
        bucket_id: 9,
        bucket_title: 'In Progress',
        title: 'Fix critical bug',
        description: 'Users cannot login',
        done: false,
        priority: 5,
        due_date: '2025-01-30T17:00:00Z',
        percent_done: 25,
        labels: [{ id: 1, title: 'urgent', hex_color: '#ff0000' }],
        assignees: [{ id: 1, username: 'johndoe', email: 'john@example.com' }],
        repeat_after: 0,
        created: '2025-01-28T10:00:00Z',
        updated: '2025-01-28T14:30:00Z',
      };

      const result = formatSuccessMessage('list-tasks', 'Found 1 task', { tasks: [task] }, { count: 1 });

      expect(result).toContain('## ✅ Success');
      expect(result).toContain('**Results:** 1 item(s)');
      // Resolved project name carried in the group header (not repeated per row)
      expect(result).toContain('📁 Backend (ID: 5)');
      // Dynamic columns present because these fields are populated
      expect(result).toContain('| ID |');
      expect(result).toContain('Column');
      expect(result).toContain('Due');
      expect(result).toContain('Pri');
      expect(result).toContain('Labels');
      expect(result).toContain('Notes');
      // Cell values
      expect(result).toContain('Fix critical bug');
      expect(result).toContain('In Progress');
      expect(result).toContain('2025-01-30');
      expect(result).toContain('urgent');
      expect(result).toContain('Users cannot login');
    });

    it('omits columns for unpopulated fields', () => {
      const task: Task = {
        id: 2,
        project_id: 5,
        title: 'Simple task',
        done: true,
        repeat_after: 0,
      };

      const result = formatSuccessMessage('list-tasks', 'Found 1 task', { tasks: [task] }, { count: 1 });

      expect(result).toContain('Simple task');
      // A title-only task collapses to just ID + Task columns
      expect(result).toContain('| ID | Task |');
      expect(result).not.toContain('Due');
      expect(result).not.toContain('Pri');
      expect(result).not.toContain('Labels');
    });

    it('shows a done column only when done states are mixed', () => {
      const tasks: Task[] = [
        { id: 1, project_id: 5, title: 'Task 1', done: false, repeat_after: 0 },
        { id: 2, project_id: 5, title: 'Task 2', done: true, repeat_after: 0 },
      ];

      const result = formatSuccessMessage('list-tasks', 'Found 2 tasks', { tasks }, { count: 2 });

      // Mixed done states → the ✓ column appears with a checkmark for the done task
      expect(result).toContain('✓');
      expect(result).toContain('✅');
      expect(result).toContain('Task 1');
      expect(result).toContain('Task 2');
    });

    it('renders multiple tasks as multiple rows under one project group', () => {
      const tasks: Task[] = [
        { id: 1, project_id: 5, title: 'Task 1', description: 'First task', priority: 5, repeat_after: 0 },
        { id: 2, project_id: 5, title: 'Task 2', priority: 2, repeat_after: 0 },
      ];

      const result = formatSuccessMessage('list-tasks', 'Found 2 tasks', { tasks }, { count: 2 });

      expect(result).toContain('📁 Project 5 — 2 task(s)');
      expect(result).toContain('Task 1');
      expect(result).toContain('Task 2');
      expect(result).toContain('First task');
      expect(result).toContain('Pri');
    });

    it('lists all labels in the Labels column', () => {
      const task: Task = {
        id: 1,
        project_id: 5,
        title: 'Labeled task',
        done: false,
        labels: [
          { id: 1, title: 'urgent', hex_color: '#ff0000' },
          { id: 2, title: 'bug', hex_color: '#ff6600' },
          { id: 3, title: 'frontend', hex_color: '#0066ff' },
        ],
        repeat_after: 0,
      };

      const result = formatSuccessMessage('list-tasks', 'Found 1 task', { tasks: [task] }, { count: 1 });

      expect(result).toContain('Labels');
      expect(result).toContain('urgent');
      expect(result).toContain('bug');
      expect(result).toContain('frontend');
    });

    it('groups tasks by project with a header per project', () => {
      const tasks: Task[] = [
        { id: 1, project_id: 5, project_title: 'Backend', title: 'API task', done: false, repeat_after: 0 },
        { id: 2, project_id: 7, project_title: 'Frontend', title: 'UI task', done: false, repeat_after: 0 },
      ];

      const result = formatSuccessMessage('list-tasks', 'Found 2 tasks', { tasks }, { count: 2 });

      expect(result).toContain('📁 Backend (ID: 5)');
      expect(result).toContain('📁 Frontend (ID: 7)');
      expect(result).toContain('API task');
      expect(result).toContain('UI task');
    });
  });

  describe('formatSuccessMessage with non-task items', () => {
    it('should format generic items with title', () => {
      const items = [
        { id: 1, title: 'Generic Item 1' },
        { id: 2, title: 'Generic Item 2' }
      ];

      const result = formatSuccessMessage(
        'list-items',
        'Found 2 items',
        { items },
        { count: 2 }
      );

      expect(result).toContain('1. **Generic Item 1** (ID: 1)');
      expect(result).toContain('2. **Generic Item 2** (ID: 2)');
    });

    it('should format generic items with name', () => {
      const items = [
        { id: 1, name: 'Named Item' }
      ];

      const result = formatSuccessMessage(
        'list-items',
        'Found 1 item',
        { items },
        { count: 1 }
      );

      expect(result).toContain('1. **Named Item** (ID: 1)');
    });

    it('should format items without id, title, or name', () => {
      const items = [
        { foo: 'bar', baz: 'qux' }
      ];

      const result = formatSuccessMessage(
        'list-items',
        'Found 1 item',
        { items },
        { count: 1 }
      );

      // When no id/title/name, it uses the entire object as the title
      expect(result).toContain('1. **');
      expect(result).toContain('"foo":"bar"');
      expect(result).toContain('"baz":"qux"');
    });

    it('should format project items', () => {
      const projects = [
        { id: 1, name: 'Project Alpha', description: 'First project' },
        { id: 2, name: 'Project Beta', description: 'Second project' }
      ];

      const result = formatSuccessMessage(
        'list-projects',
        'Found 2 projects',
        { projects },
        { count: 2 }
      );

      expect(result).toContain('1. **Project Alpha** (ID: 1)');
      expect(result).toContain('2. **Project Beta** (ID: 2)');
    });

    it('should format label items', () => {
      const labels = [
        { id: 1, title: 'urgent', hex_color: '#ff0000' },
        { id: 2, title: 'bug', hex_color: '#ff6600' }
      ];

      const result = formatSuccessMessage(
        'list-labels',
        'Found 2 labels',
        { labels },
        { count: 2 }
      );

      expect(result).toContain('1. **urgent** (ID: 1)');
      expect(result).toContain('2. **bug** (ID: 2)');
    });
  });

  describe('createSuccessResponse', () => {
    it('should create response with tasks', () => {
      const task: Task = {
        id: 1,
        project_id: 5,
        title: 'Test task',
        done: false,
        priority: 3,
        repeat_after: 0
      };

      const response = createSuccessResponse(
        'get-task',
        'Task retrieved',
        { tasks: [task] },
        { taskId: 1 }
      );

      expect(response.content).toContain('## ✅ Success');
      expect(response.content).toContain('Test task');
      // Envelope metadata still carries operation/taskId even though they are
      // suppressed from the rendered content.
      expect(response.metadata).toBeDefined();
      expect(response.metadata?.success).toBe(true);
      expect(response.metadata?.operation).toBe('get-task');
      expect(response.metadata?.taskId).toBe(1);
    });
  });

  describe('createErrorResponse', () => {
    it('should create error response', () => {
      const response = createErrorResponse(
        'delete-task',
        'Task not found',
        'NOT_FOUND',
        { taskId: 999 }
      );

      expect(response.content).toContain('❌ Error');
      expect(response.content).toContain('Task not found');
      expect(response.content).toContain('NOT_FOUND');
      expect(response.metadata?.success).toBe(false);
      expect(response.metadata?.error).toBeDefined();
      expect(response.metadata?.error?.code).toBe('NOT_FOUND');
    });
  });

  describe('Edge cases', () => {
    it('should handle empty array', () => {
      const result = formatSuccessMessage(
        'list-tasks',
        'No tasks found',
        { tasks: [] },
        { count: 0 }
      );

      expect(result).toContain('**Results:**');
      expect(result).toContain('0 item(s)');
    });

    it('renders all items when at or below the render cap', () => {
      const tasks: Task[] = Array.from({ length: 15 }, (_, i) => ({
        id: i + 1,
        project_id: 1,
        title: `Task ${i + 1}`,
        done: false,
        repeat_after: 0
      }));

      const result = formatSuccessMessage(
        'list-tasks',
        'Found 15 tasks',
        { tasks },
        { count: 15 }
      );

      expect(result).toContain('**Results:** 15 item(s)');
      // The cap is 100, so all 15 render (first and last present)
      expect(result).toContain('Task 1');
      expect(result).toContain('Task 15');
      expect(result).not.toContain('Showing first');
    });

    it('truncates and notes the remainder above the render cap', () => {
      const tasks: Task[] = Array.from({ length: 105 }, (_, i) => ({
        id: i + 1,
        project_id: 1,
        title: `Task ${i + 1}`,
        done: false,
        repeat_after: 0
      }));

      const result = formatSuccessMessage(
        'list-tasks',
        'Found 105 tasks',
        { tasks },
        { count: 105 }
      );

      expect(result).toContain('**Results:** 105 item(s)');
      expect(result).toContain('Showing first 100 of 105');
    });
  });
});
