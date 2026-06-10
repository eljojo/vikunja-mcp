import type { Task, VikunjaClient } from 'node-vikunja';

interface ExpectedRelationships {
  labels?: number[];
  assignees?: number[];
}

const VERIFICATION_DELAYS_MS = [100, 250, 500];

export async function getTaskWithRelationships(
  client: VikunjaClient,
  taskId: number,
  expected: ExpectedRelationships,
): Promise<Task> {
  let task = await client.tasks.getTask(taskId);

  for (const delayMs of VERIFICATION_DELAYS_MS) {
    if (hasExpectedRelationships(task, expected)) {
      return task;
    }

    await delay(delayMs);
    task = await client.tasks.getTask(taskId);
  }

  return task;
}

export function hasExpectedRelationships(
  task: Task,
  expected: ExpectedRelationships,
): boolean {
  return (
    matchesIds(expected.labels, task.labels?.map((label) => label.id)) &&
    matchesIds(expected.assignees, task.assignees?.map((assignee) => assignee.id))
  );
}

function matchesIds(
  expectedIds: number[] | undefined,
  actualIds: Array<number | undefined> | undefined,
): boolean {
  if (expectedIds === undefined) {
    return true;
  }

  const expected = [...new Set(expectedIds)].sort((a, b) => a - b);
  const actual = [...new Set(
    (actualIds ?? []).filter((id): id is number => id !== undefined),
  )].sort((a, b) => a - b);

  return expected.length === actual.length &&
    expected.every((id, index) => id === actual[index]);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
