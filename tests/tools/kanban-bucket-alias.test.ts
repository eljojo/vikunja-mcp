import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { registerKanbanTool } from '../../src/tools/kanban';
import { getClientFromContext } from '../../src/client';

jest.mock('../../src/client', () => ({
  getClientFromContext: jest.fn(),
  setGlobalClientFactory: jest.fn(),
}));

describe('vikunja_kanban - bucketId / intoBucketId aliasing', () => {
  let service: {
    getProjectViews: jest.Mock;
    getBucketsForView: jest.Mock;
    moveTaskToBucket: jest.Mock;
    updateTaskPosition: jest.Mock;
  };
  let handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

  const authManager = { isAuthenticated: jest.fn().mockReturnValue(true) } as never;

  beforeEach(() => {
    jest.clearAllMocks();
    service = {
      getProjectViews: jest.fn(),
      getBucketsForView: jest.fn(),
      moveTaskToBucket: jest.fn(),
      updateTaskPosition: jest.fn(),
    };
    (getClientFromContext as jest.Mock).mockResolvedValue({ tasks: service });

    const server = { tool: jest.fn() };
    registerKanbanTool(server as never, authManager);
    handler = server.tool.mock.calls[0][3] as typeof handler;
  });

  it('move-task accepts intoBucketId as an alias for bucketId', async () => {
    service.moveTaskToBucket.mockResolvedValue({});
    service.getBucketsForView.mockResolvedValue([{ id: 5, tasks: [{ id: 10 }] }]);

    const result = await handler({ operation: 'move-task', projectId: 1, taskId: 10, intoBucketId: 5, viewId: 2 });

    expect(service.moveTaskToBucket).toHaveBeenCalledWith(1, 2, 5, 10);
    expect(result.content[0].text).toContain('Moved task 10 to column 5 (verified)');
  });

  it('bulk-move accepts intoBucketId as an alias for bucketId', async () => {
    service.moveTaskToBucket.mockResolvedValue({});
    service.getBucketsForView.mockResolvedValue([{ id: 5, tasks: [{ id: 10 }, { id: 11 }] }]);

    const result = await handler({ operation: 'bulk-move', projectId: 1, taskIds: [10, 11], intoBucketId: 5, viewId: 2 });

    expect(service.moveTaskToBucket).toHaveBeenCalledTimes(2);
    expect(result.content[0].text).toContain('Moved 2/2 task(s) to column 5 (verified)');
  });

  it('still prefers an explicit bucketId when both are supplied', async () => {
    service.moveTaskToBucket.mockResolvedValue({});
    service.getBucketsForView.mockResolvedValue([{ id: 8, tasks: [{ id: 10 }] }]);

    await handler({ operation: 'move-task', projectId: 1, taskId: 10, bucketId: 8, intoBucketId: 5, viewId: 2 });

    expect(service.moveTaskToBucket).toHaveBeenCalledWith(1, 2, 8, 10);
  });

  it('move-task errors when neither bucketId nor intoBucketId is given', async () => {
    await expect(
      handler({ operation: 'move-task', projectId: 1, taskId: 10, viewId: 2 }),
    ).rejects.toThrow('taskId and bucketId (or intoBucketId) are required');
  });

  describe('set-task-position', () => {
    it('sets a task position within a view', async () => {
      service.updateTaskPosition.mockResolvedValue({ task_id: 10, project_view_id: 2, position: 96 });

      const result = await handler({
        operation: 'set-task-position',
        projectId: 1,
        taskId: 10,
        position: 96,
        viewId: 2,
      });

      expect(service.updateTaskPosition).toHaveBeenCalledWith(10, 2, 96);
      expect(result.content[0].text).toContain('Set task 10 to position 96 in view 2');
    });

    it('resolves the kanban view when no viewId is given', async () => {
      service.getProjectViews.mockResolvedValue([{ id: 7, view_kind: 'kanban' }]);
      service.updateTaskPosition.mockResolvedValue({});

      await handler({ operation: 'set-task-position', projectId: 1, taskId: 10, position: 5 });

      expect(service.updateTaskPosition).toHaveBeenCalledWith(10, 7, 5);
    });

    it('errors when taskId or position is missing', async () => {
      await expect(
        handler({ operation: 'set-task-position', projectId: 1, taskId: 10, viewId: 2 }),
      ).rejects.toThrow('taskId and position are required');
    });
  });
});
