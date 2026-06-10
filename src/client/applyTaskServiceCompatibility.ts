import type { GetTasksParams, Task, TaskService } from 'node-vikunja';

type TaskServiceWithRequest = TaskService & {
  request<T>(
    endpoint: string,
    method: 'GET',
    body?: unknown,
    options?: { params?: GetTasksParams }
  ): Promise<T>;
};

function hasRequestMethod(service: unknown): service is TaskServiceWithRequest {
  return (
    typeof service === 'object' &&
    service !== null &&
    'request' in service &&
    typeof service.request === 'function' &&
    'getAllTasks' in service &&
    typeof service.getAllTasks === 'function'
  );
}

/**
 * Work around node-vikunja 0.4.0 using the removed /tasks/all endpoint.
 */
export function applyTaskServiceCompatibility(service: unknown): void {
  if (!hasRequestMethod(service)) {
    return;
  }

  service.getAllTasks = (params?: GetTasksParams): Promise<Task[]> => {
    const options = params === undefined ? undefined : { params };
    return service.request<Task[]>('/tasks', 'GET', undefined, options);
  };
}
