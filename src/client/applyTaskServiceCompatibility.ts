import type {
  BulkAssignees,
  GetTasksParams,
  LabelTaskBulk,
  Task,
  TaskAssignment,
  TaskService,
} from 'node-vikunja';

type TaskServiceWithRequest = TaskService & {
  request<T>(
    endpoint: string,
    method: 'GET' | 'POST',
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

  service.updateTaskLabels = (
    taskId: number,
    labels: LabelTaskBulk,
  ): Promise<LabelTaskBulk> => service.request<LabelTaskBulk>(
    `/tasks/${taskId}/labels/bulk`,
    'POST',
    { labels: labels.label_ids.map((id) => ({ id })) },
  );

  service.bulkAssignUsersToTask = (
    taskId: number,
    assignees: BulkAssignees,
  ): Promise<TaskAssignment> => service.request<TaskAssignment>(
    `/tasks/${taskId}/assignees/bulk`,
    'POST',
    { assignees: assignees.user_ids.map((id) => ({ id })) },
  );
}
