import { describe, expect, it } from '@jest/globals';
import type { Task } from 'node-vikunja';
import { FilterExecutor } from '../../../src/tools/tasks/filtering';

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
