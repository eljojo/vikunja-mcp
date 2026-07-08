import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { createTask } from '../../src/tools/tasks/crud/TaskCreationService';
import { getClientFromContext } from '../../src/client';

jest.mock('../../src/client', () => ({
  getClientFromContext: jest.fn(),
}));

describe('createTask - Kanban bucket placement on create', () => {
  let service: {
    createTask: jest.Mock;
    getTask: jest.Mock;
    getProjectViews: jest.Mock;
    moveTaskToBucket: jest.Mock;
    getBucketsForView: jest.Mock;
  };

  const createdTask = { id: 100, title: 'T', project_id: 3 };

  beforeEach(() => {
    jest.clearAllMocks();
    service = {
      createTask: jest.fn().mockResolvedValue(createdTask),
      getTask: jest.fn().mockResolvedValue(createdTask),
      getProjectViews: jest.fn(),
      moveTaskToBucket: jest.fn(),
      getBucketsForView: jest.fn(),
    };
    (getClientFromContext as jest.Mock).mockResolvedValue({ tasks: service });
  });

  it('moves the created task into the requested bucket and verifies it landed', async () => {
    service.getProjectViews.mockResolvedValue([{ id: 2, view_kind: 'kanban' }]);
    service.moveTaskToBucket.mockResolvedValue({});
    service.getBucketsForView.mockResolvedValue([{ id: 7, tasks: [{ id: 100 }] }]);

    const result = await createTask({ projectId: 3, title: 'T', bucketId: 7 });

    // Resolved the Kanban view (2) then moved task 100 into bucket 7.
    expect(service.moveTaskToBucket).toHaveBeenCalledWith(3, 2, 7, 100);
    expect(result.content[0].type).toBe('text');
  });

  it('uses a provided viewId/bucket_id alias instead of resolving the Kanban view', async () => {
    service.moveTaskToBucket.mockResolvedValue({});
    service.getBucketsForView.mockResolvedValue([{ id: 7, tasks: [{ id: 100 }] }]);

    await createTask({ projectId: 3, title: 'T', bucket_id: 7, view_id: 9 });

    expect(service.getProjectViews).not.toHaveBeenCalled();
    expect(service.moveTaskToBucket).toHaveBeenCalledWith(3, 9, 7, 100);
  });

  it('fails loudly if the task did not land in the requested bucket', async () => {
    service.getProjectViews.mockResolvedValue([{ id: 2, view_kind: 'kanban' }]);
    service.moveTaskToBucket.mockResolvedValue({});
    service.getBucketsForView.mockResolvedValue([{ id: 7, tasks: [] }]);

    await expect(createTask({ projectId: 3, title: 'T', bucketId: 7 })).rejects.toThrow(
      'did not land in bucket 7',
    );
  });

  it('reports the created task id when the move call itself fails', async () => {
    service.getProjectViews.mockResolvedValue([{ id: 2, view_kind: 'kanban' }]);
    service.moveTaskToBucket.mockRejectedValue(new Error('boom'));

    await expect(createTask({ projectId: 3, title: 'T', bucketId: 7 })).rejects.toThrow(
      'Task 100 was created in project 3 but could not be moved to bucket 7',
    );
  });

  it('keeps the task when bucket verification cannot be read (best-effort)', async () => {
    service.getProjectViews.mockResolvedValue([{ id: 2, view_kind: 'kanban' }]);
    service.moveTaskToBucket.mockResolvedValue({});
    service.getBucketsForView.mockRejectedValue(new Error('read failed'));

    const result = await createTask({ projectId: 3, title: 'T', bucketId: 7 });

    expect(result.content[0].type).toBe('text');
  });

  it('does not touch Kanban endpoints when no bucket is requested', async () => {
    await createTask({ projectId: 3, title: 'T' });

    expect(service.moveTaskToBucket).not.toHaveBeenCalled();
    expect(service.getProjectViews).not.toHaveBeenCalled();
  });
});
