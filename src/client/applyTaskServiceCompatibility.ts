import type {
  BulkAssignees,
  GetTasksParams,
  LabelTaskBulk,
  Task,
  TaskAssignment,
  TaskService,
} from 'node-vikunja';

type TaskServiceWithRequest = TaskServiceWithBucketSupport & {
  request<T>(
    endpoint: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
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

export interface TaskBucket {
  id: number;
  title?: string;
  position?: number;
  limit?: number;
  count?: number;
  project_view_id?: number;
  tasks?: Task[];
}

/** Fields accepted when creating/updating a bucket. */
export interface BucketInput {
  title?: string;
  position?: number;
  limit?: number;
}

/** Minimal project view shape. Vikunja reports the kind as `view_kind`. */
export interface ProjectViewLite {
  id: number;
  project_id: number;
  title: string;
  view_kind: 'list' | 'kanban' | 'table' | 'gantt';
  position?: number;
  filter?: unknown;
  bucket_configuration_mode?: string;
  bucket_configuration?: unknown;
  default_bucket_id?: number;
  done_bucket_id?: number;
}

type TaskServiceWithBucketSupport = TaskService & {
  moveTaskToBucket(
    projectId: number,
    viewId: number,
    bucketId: number,
    taskId: number,
  ): Promise<TaskBucketRelation>;
  getBucketsForView(
    projectId: number,
    viewId: number,
  ): Promise<TaskBucket[]>;
  getProjectViews(
    projectId: number,
  ): Promise<ProjectViewLite[]>;
  getViewBuckets(
    projectId: number,
    viewId: number,
  ): Promise<TaskBucket[]>;
  createBucket(
    projectId: number,
    viewId: number,
    bucket: BucketInput,
  ): Promise<TaskBucket>;
  updateBucket(
    projectId: number,
    viewId: number,
    bucketId: number,
    bucket: BucketInput,
  ): Promise<TaskBucket>;
  deleteBucket(
    projectId: number,
    viewId: number,
    bucketId: number,
  ): Promise<void>;
  updateView(
    projectId: number,
    viewId: number,
    view: ProjectViewLite,
  ): Promise<ProjectViewLite>;
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
    { task_id: taskId, bucket_id: bucketId, project_view_id: viewId },
  );

  service.getBucketsForView = (
    projectId: number,
    viewId: number,
  ): Promise<TaskBucket[]> => service.request<TaskBucket[]>(
    `/projects/${projectId}/views/${viewId}/tasks`,
    'GET',
    undefined,
    { params: { page: 1, per_page: 500 } },
  );

  service.getProjectViews = (
    projectId: number,
  ): Promise<ProjectViewLite[]> => service.request<ProjectViewLite[]>(
    `/projects/${projectId}/views`,
    'GET',
  );

  service.getViewBuckets = (
    projectId: number,
    viewId: number,
  ): Promise<TaskBucket[]> => service.request<TaskBucket[]>(
    `/projects/${projectId}/views/${viewId}/buckets`,
    'GET',
  );

  service.createBucket = (
    projectId: number,
    viewId: number,
    bucket: BucketInput,
  ): Promise<TaskBucket> => service.request<TaskBucket>(
    `/projects/${projectId}/views/${viewId}/buckets`,
    'PUT',
    bucket,
  );

  service.updateBucket = (
    projectId: number,
    viewId: number,
    bucketId: number,
    bucket: BucketInput,
  ): Promise<TaskBucket> => service.request<TaskBucket>(
    `/projects/${projectId}/views/${viewId}/buckets/${bucketId}`,
    'POST',
    bucket,
  );

  service.deleteBucket = (
    projectId: number,
    viewId: number,
    bucketId: number,
  ): Promise<void> => service.request<unknown>(
    `/projects/${projectId}/views/${viewId}/buckets/${bucketId}`,
    'DELETE',
  ).then(() => undefined);

  service.updateView = (
    projectId: number,
    viewId: number,
    view: ProjectViewLite,
  ): Promise<ProjectViewLite> => service.request<ProjectViewLite>(
    `/projects/${projectId}/views/${viewId}`,
    'POST',
    view,
  );
}

export function getProjectViews(
  service: TaskService,
  projectId: number,
): Promise<ProjectViewLite[]> {
  if (!('getProjectViews' in service) || typeof service.getProjectViews !== 'function') {
    throw new Error('The Vikunja task service does not support reading project views');
  }

  return (service as TaskServiceWithBucketSupport).getProjectViews(projectId);
}

function asBucketService(service: TaskService): TaskServiceWithBucketSupport {
  if (!('createBucket' in service) || typeof service.createBucket !== 'function') {
    throw new Error('The Vikunja task service does not support bucket management');
  }
  return service as TaskServiceWithBucketSupport;
}

export function getViewBuckets(
  service: TaskService,
  projectId: number,
  viewId: number,
): Promise<TaskBucket[]> {
  return asBucketService(service).getViewBuckets(projectId, viewId);
}

export function createBucket(
  service: TaskService,
  projectId: number,
  viewId: number,
  bucket: BucketInput,
): Promise<TaskBucket> {
  return asBucketService(service).createBucket(projectId, viewId, bucket);
}

export function updateBucket(
  service: TaskService,
  projectId: number,
  viewId: number,
  bucketId: number,
  bucket: BucketInput,
): Promise<TaskBucket> {
  return asBucketService(service).updateBucket(projectId, viewId, bucketId, bucket);
}

export function deleteBucket(
  service: TaskService,
  projectId: number,
  viewId: number,
  bucketId: number,
): Promise<void> {
  return asBucketService(service).deleteBucket(projectId, viewId, bucketId);
}

export function updateView(
  service: TaskService,
  projectId: number,
  viewId: number,
  view: ProjectViewLite,
): Promise<ProjectViewLite> {
  return asBucketService(service).updateView(projectId, viewId, view);
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

  return (service as TaskServiceWithBucketSupport)
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

export function getBucketsForView(
  service: TaskService,
  projectId: number,
  viewId: number,
): Promise<TaskBucket[]> {
  if (!('getBucketsForView' in service) || typeof service.getBucketsForView !== 'function') {
    throw new Error('The Vikunja task service does not support reading view buckets');
  }

  return (service as TaskServiceWithBucketSupport)
    .getBucketsForView(projectId, viewId)
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (/missing, malformed, expired|invalid token/i.test(message)) {
        throw new Error(
          'Vikunja rejected the API token for the Kanban bucket route. ' +
          'Create a new token with the projects.views_buckets permission. ' +
          `Original error: ${message}`,
        );
      }
      throw error;
    });
}

export async function enrichTasksWithBucketIds(
  service: TaskService,
  tasks: Task[],
  viewId: number,
): Promise<Task[]> {
  const tasksByProject = new Map<number, Task[]>();
  for (const task of tasks) {
    if (task.project_id === undefined) {
      continue;
    }
    const projectTasks = tasksByProject.get(task.project_id) ?? [];
    projectTasks.push(task);
    tasksByProject.set(task.project_id, projectTasks);
  }

  const bucketIdsByTaskId = new Map<number, number>();
  await Promise.all(
    Array.from(tasksByProject.keys()).map(async (projectId) => {
      const buckets = await getBucketsForView(service, projectId, viewId);
      for (const bucket of buckets) {
        if (!Array.isArray(bucket.tasks)) {
          continue;
        }
        for (const bucketTask of bucket.tasks) {
          if (bucketTask.id !== undefined) {
            bucketIdsByTaskId.set(bucketTask.id, bucket.id);
          }
        }
      }
    }),
  );

  return tasks.map((task) => {
    const bucketId = task.id === undefined ? undefined : bucketIdsByTaskId.get(task.id);
    return bucketId === undefined ? task : { ...task, bucket_id: bucketId };
  });
}
