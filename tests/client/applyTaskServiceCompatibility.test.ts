import { describe, expect, it, jest } from '@jest/globals';
import {
  applyTaskServiceCompatibility,
  enrichTasksWithBucketIds,
  getBucketsForView,
  moveTaskToBucket,
} from '../../src/client/applyTaskServiceCompatibility';
import type { TaskService } from 'node-vikunja';

describe('applyTaskServiceCompatibility', () => {
  it('gets all tasks from the supported endpoint', async () => {
    const request = jest.fn().mockResolvedValue([{ id: 42, title: 'Task' }]);
    const service = {
      getAllTasks: jest.fn(),
      request,
    } as unknown as TaskService;

    applyTaskServiceCompatibility(service);

    await expect(service.getAllTasks({ page: 2, per_page: 25 })).resolves.toEqual([
      { id: 42, title: 'Task' },
    ]);
    expect(request).toHaveBeenCalledWith('/tasks', 'GET', undefined, {
      params: { page: 2, per_page: 25 },
    });
  });

  it('uses Vikunja 2.x relationship payloads', async () => {
    const request = jest.fn().mockResolvedValue({});
    const service = {
      getAllTasks: jest.fn(),
      updateTaskLabels: jest.fn(),
      bulkAssignUsersToTask: jest.fn(),
      request,
    } as unknown as TaskService;

    applyTaskServiceCompatibility(service);

    await service.updateTaskLabels(21, { label_ids: [2, 3] });
    await service.bulkAssignUsersToTask(21, { user_ids: [1, 4] });
    await (service as TaskService & {
      moveTaskToBucket: (
        projectId: number,
        viewId: number,
        bucketId: number,
        taskId: number,
      ) => Promise<unknown>;
      getBucketsForView: (
        projectId: number,
        viewId: number,
      ) => Promise<unknown>;
    }).moveTaskToBucket(13, 52, 39, 35);
    await (service as TaskService & {
      getBucketsForView: (
        projectId: number,
        viewId: number,
      ) => Promise<unknown>;
    }).getBucketsForView(13, 52);

    expect(request).toHaveBeenNthCalledWith(
      1,
      '/tasks/21/labels/bulk',
      'POST',
      { labels: [{ id: 2 }, { id: 3 }] },
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      '/tasks/21/assignees/bulk',
      'POST',
      { assignees: [{ id: 1 }, { id: 4 }] },
    );
    expect(request).toHaveBeenNthCalledWith(
      3,
      '/projects/13/views/52/buckets/39/tasks',
      'POST',
      { task_id: 35 },
    );
    expect(request).toHaveBeenNthCalledWith(
      4,
      '/projects/13/views/52/buckets',
      'GET',
      undefined,
      { params: { page: 1, per_page: 500 } },
    );
  });

  it('leaves injected task service mocks unchanged', () => {
    const getAllTasks = jest.fn();
    const service = { getAllTasks } as unknown as TaskService;

    applyTaskServiceCompatibility(service);

    expect(service.getAllTasks).toBe(getAllTasks);
  });

  it('explains the API token permission required for bucket moves', async () => {
    const service = {
      moveTaskToBucket: jest.fn().mockRejectedValue(
        new Error('missing, malformed, expired or otherwise invalid token provided'),
      ),
    } as unknown as TaskService;

    await expect(moveTaskToBucket(service, 13, 52, 39, 35)).rejects.toThrow(
      'projects.views_buckets_tasks permission',
    );
  });

  it('explains the API token permission required for bucket reads', async () => {
    const service = {
      getBucketsForView: jest.fn().mockRejectedValue(
        new Error('missing, malformed, expired or otherwise invalid token provided'),
      ),
    } as unknown as TaskService;

    await expect(getBucketsForView(service, 13, 52)).rejects.toThrow(
      'projects.views_buckets permission',
    );
  });

  it('enriches task bucket ids from view buckets', async () => {
    const service = {
      getBucketsForView: jest.fn().mockResolvedValue([
        { id: 38, tasks: [{ id: 16, project_id: 13, title: 'One' }] },
        { id: 39, tasks: [{ id: 35, project_id: 13, title: 'Two' }] },
      ]),
    } as unknown as TaskService;

    await expect(enrichTasksWithBucketIds(
      service,
      [
        { id: 16, project_id: 13, title: 'One', bucket_id: 0 },
        { id: 35, project_id: 13, title: 'Two', bucket_id: 0 },
      ] as any,
      52,
    )).resolves.toMatchObject([
      { id: 16, bucket_id: 38 },
      { id: 35, bucket_id: 39 },
    ]);
  });
});
