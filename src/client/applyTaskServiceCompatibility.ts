import type {
  BulkAssignees,
  GetTasksParams,
  LabelTaskBulk,
  Task,
  TaskAssignment,
  TaskService,
} from 'node-vikunja';

type TaskServiceWithRequest = TaskServiceWithBucketMove & {
  request<T>(
    endpoint: string,
    method: 'GET' | 'POST',
    body?: unknown,
    options?: { params?: GetTasksParams }
  ): Promise<T>;
};

export interface TaskBucketRelation {
  bucket_id: number;
  task_id: number;
  project_view_id: number;
  task?: Task;
}

type TaskServiceWithBucketMove = TaskService & {
  moveTaskToBucket(
    projectId: number,
    viewId: number,
    bucketId: number,
    taskId: number,
  ): Promise<TaskBucketRelation>;
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

  service.moveTaskToBucket = (
    projectId: number,
    viewId: number,
    bucketId: number,
    taskId: number,
  ): Promise<TaskBucketRelation> => service.request<TaskBucketRelation>(
    `/projects/${projectId}/views/${viewId}/buckets/${bucketId}/tasks`,
    'POST',
    { task_id: taskId },
  );
}

export function moveTaskToBucket(
  service: TaskService,
  projectId: number,
  viewId: number,
  bucketId: number,
  taskId: number,
): Promise<TaskBucketRelation> {
  if (!('moveTaskToBucket' in service) || typeof service.moveTaskToBucket !== 'function') {
    throw new Error('The Vikunja task service does not support bucket moves');
  }

  return (service as TaskServiceWithBucketMove)
    .moveTaskToBucket(projectId, viewId, bucketId, taskId)
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (/missing, malformed, expired|invalid token/i.test(message)) {
        throw new Error(
          'Vikunja rejected the API token for the Kanban bucket route. ' +
          'Create a new token with the projects.views_buckets_tasks permission. ' +
          `Original error: ${message}`,
        );
      }
      throw error;
    });
}
