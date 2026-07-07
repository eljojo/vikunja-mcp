import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Task } from 'node-vikunja';

jest.mock('../../../src/client', () => ({
  getClientFromContext: jest.fn(),
}));

import { FilterExecutor } from '../../../src/tools/tasks/filtering';

const { getClientFromContext } = require('../../../src/client');

describe('FilterExecutor post-processing filters', () => {
  const tasks = [
    { id: 1, title: 'Backlog task', done: false, bucket_id: 10 },
    { id: 2, title: 'Doing task', done: false, bucket_id: 20 },
    { id: 3, title: 'Done task', done: true, bucket_id: 20 },
  ] as Task[];

  it('filters listed tasks by bucketId', () => {
    expect(FilterExecutor.applyPostProcessingFilters(tasks, { bucketId: 20 }))
      .toEqual([tasks[1], tasks[2]]);
  });

  it('accepts bucket_id as the list filter alias', () => {
    expect(FilterExecutor.applyPostProcessingFilters(tasks, { bucket_id: 10 }))
      .toEqual([tasks[0]]);
  });

  it('combines bucket and done filters', () => {
    expect(FilterExecutor.applyPostProcessingFilters(tasks, { bucketId: 20, done: true }))
      .toEqual([tasks[2]]);
  });
});

describe('FilterExecutor bucket enrichment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('filters by bucket after enriching tasks from view buckets', async () => {
    const loadedTasks = [
      { id: 16, project_id: 13, title: 'Moved task', done: false, bucket_id: 0 },
      { id: 35, project_id: 13, title: 'Other task', done: false, bucket_id: 0 },
    ] as Task[];
    const mockClient = {
      tasks: {
        getProjectTasks: jest.fn().mockResolvedValue(loadedTasks),
        getAllTasks: jest.fn(),
        getBucketsForView: jest.fn().mockResolvedValue([
          { id: 38, tasks: [{ id: 35, project_id: 13, title: 'Other task' }] },
          { id: 39, tasks: [{ id: 16, project_id: 13, title: 'Moved task' }] },
        ]),
      },
    };
    getClientFromContext.mockResolvedValue(mockClient);

    const result = await FilterExecutor.executeFiltering(
      { projectId: 13, viewId: 52, bucketId: 39 },
      null,
      undefined,
      { page: 1, per_page: 100 },
      {} as never,
    );

    expect(mockClient.tasks.getBucketsForView).toHaveBeenCalledWith(13, 52);
    expect(result.tasks).toEqual([
      expect.objectContaining({ id: 16, bucket_id: 39 }),
    ]);
  });

  it('requires viewId when filtering by bucket', async () => {
    const mockClient = {
      tasks: {
        getProjectTasks: jest.fn().mockResolvedValue([]),
        getAllTasks: jest.fn(),
      },
    };
    getClientFromContext.mockResolvedValue(mockClient);

    await expect(FilterExecutor.executeFiltering(
      { projectId: 13, bucketId: 39 },
      null,
      undefined,
      { page: 1, per_page: 100 },
      {} as never,
    )).rejects.toThrow('viewId is required when filtering tasks by bucket');
  });
});
