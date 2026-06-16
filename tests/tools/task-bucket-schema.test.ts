import { describe, expect, it, jest } from '@jest/globals';
import { registerTaskCrudTool } from '../../src/tools/task-crud';
import { registerTasksTool } from '../../src/tools/tasks';

describe('task bucket schemas', () => {
  const authManager = {
    isAuthenticated: jest.fn().mockReturnValue(true),
  };

  it.each([
    ['vikunja_tasks', registerTasksTool],
    ['vikunja_task_crud', registerTaskCrudTool],
  ])('exposes bucket aliases on %s', (toolName, registerTool) => {
    const server = { tool: jest.fn() };

    registerTool(server as never, authManager as never);

    expect(server.tool).toHaveBeenCalledWith(
      toolName,
      expect.any(String),
      expect.objectContaining({
        bucketId: expect.any(Object),
        bucket_id: expect.any(Object),
        viewId: expect.any(Object),
        view_id: expect.any(Object),
      }),
      expect.any(Function),
    );
  });
});
