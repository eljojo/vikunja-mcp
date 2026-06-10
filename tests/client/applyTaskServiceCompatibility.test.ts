import { describe, expect, it, jest } from '@jest/globals';
import { applyTaskServiceCompatibility } from '../../src/client/applyTaskServiceCompatibility';
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

  it('leaves injected task service mocks unchanged', () => {
    const getAllTasks = jest.fn();
    const service = { getAllTasks } as unknown as TaskService;

    applyTaskServiceCompatibility(service);

    expect(service.getAllTasks).toBe(getAllTasks);
  });
});
