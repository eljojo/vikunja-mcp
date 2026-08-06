import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { updateTask } from '../../src/tools/tasks/crud/TaskUpdateService';
import { getClientFromContext } from '../../src/client';

jest.mock('../../src/client', () => ({
  getClientFromContext: jest.fn(),
}));

describe('updateTask - Kanban bucket placement on update', () => {
  let service: {
    getTask: jest.Mock;
    updateTask: jest.Mock;
    moveTaskToBucket: jest.Mock;
    getBucketsForView: jest.Mock;
  };

  const task = { id: 711, title: 'T', project_id: 32 };

  beforeEach(() => {
    jest.clearAllMocks();
    service = {
      getTask: jest.fn().mockResolvedValue(task),
      updateTask: jest.fn().mockResolvedValue(task),
      // The bucket-tasks endpoint echoes the requested bucket straight back,
      // so its response says nothing about whether the task was seated.
      moveTaskToBucket: jest.fn().mockResolvedValue({ task_id: 711, bucket_id: 249, project_view_id: 132 }),
      getBucketsForView: jest.fn(),
    };
    (getClientFromContext as jest.Mock).mockResolvedValue({ tasks: service });
  });

  it('fails when the board does not show the task in the requested bucket', async () => {
    service.getBucketsForView.mockResolvedValue([
      { id: 247, tasks: [{ id: 711 }] },
      { id: 249, tasks: [{ id: 900 }] },
    ]);

    await expect(updateTask({ id: 711, bucketId: 249, viewId: 132 })).rejects.toThrow(
      'Task 711 was not moved to bucket 249',
    );
  });

  it('succeeds when the board shows the task in the requested bucket', async () => {
    service.getBucketsForView.mockResolvedValue([
      { id: 249, tasks: [{ id: 900 }, { id: 711 }] },
    ]);

    const result = await updateTask({ id: 711, bucketId: 249, viewId: 132 });

    expect(service.moveTaskToBucket).toHaveBeenCalledWith(32, 132, 249, 711);
    expect(service.getBucketsForView).toHaveBeenCalledWith(32, 132);
    expect(result.content[0].text).toContain('updated');
  });

  it('does not claim success when the board cannot be read back', async () => {
    service.getBucketsForView.mockRejectedValue(new Error('read failed'));

    await expect(updateTask({ id: 711, bucketId: 249, viewId: 132 })).rejects.toThrow(
      'could not be verified',
    );
  });

  it('does not read the board when no bucket is requested', async () => {
    await updateTask({ id: 711, title: 'New title' });

    expect(service.moveTaskToBucket).not.toHaveBeenCalled();
    expect(service.getBucketsForView).not.toHaveBeenCalled();
  });
});
