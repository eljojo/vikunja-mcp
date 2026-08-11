import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { z } from 'zod';
import { registerProjectsTool } from '../../src/tools/projects';
import { registerTaskCommentsTool } from '../../src/tools/task-comments';
import { registerTaskLabelsTool } from '../../src/tools/task-labels';
import { getClientFromContext } from '../../src/client';

jest.mock('../../src/client', () => ({
  getClientFromContext: jest.fn(),
  setGlobalClientFactory: jest.fn(),
}));

type ToolResult = { content: Array<{ type: string; text: string }> };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

/**
 * These tools grew parameter aliases so a caller who guesses the name every
 * other vikunja tool uses is not punished for it. The aliases only pay off if
 * both spellings land on the same code path, so each case asserts the
 * downstream call, not just a non-error.
 */

describe('vikunja_projects - operation / subcommand aliasing', () => {
  let projects: { getProject: jest.Mock };
  let handler: ToolHandler;

  function register(authenticated: boolean): ToolHandler {
    const server = { tool: jest.fn() };
    const authManager = { isAuthenticated: jest.fn().mockReturnValue(authenticated) };
    registerProjectsTool(server as never, authManager as never);
    return server.tool.mock.calls[0][3] as ToolHandler;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    projects = { getProject: jest.fn() };
    projects.getProject.mockResolvedValue({ id: 5, title: 'Test Project' });
    (getClientFromContext as jest.Mock).mockResolvedValue({ projects });
    handler = register(true);
  });

  it('reaches the same code path for operation: get and subcommand: get', async () => {
    const viaOperation = await handler({ operation: 'get', id: 5 });
    const viaSubcommand = await handler({ subcommand: 'get', id: 5 });

    expect(projects.getProject).toHaveBeenNthCalledWith(1, 5);
    expect(projects.getProject).toHaveBeenNthCalledWith(2, 5);
    expect(viaSubcommand).toEqual(viaOperation);
    expect(viaOperation.content[0].text).toContain('Retrieved project: Test Project');
  });

  it('rejects operation and subcommand disagreeing', async () => {
    await expect(handler({ operation: 'get', subcommand: 'list', id: 5 })).rejects.toThrow(
      'must match',
    );
    expect(projects.getProject).not.toHaveBeenCalled();
  });

  it('accepts operation and subcommand when they agree', async () => {
    await handler({ operation: 'get', subcommand: 'get', id: 5 });

    expect(projects.getProject).toHaveBeenCalledWith(5);
  });

  it('names operation when neither verb is given', async () => {
    await expect(handler({ id: 5 })).rejects.toThrow(/operation is required/);
  });

  it('reports the auth failure, not the missing operation, when unauthenticated', async () => {
    const unauthenticated = register(false);

    await expect(unauthenticated({ id: 5 })).rejects.toThrow(/Authentication required/);
    await expect(unauthenticated({ id: 5 })).rejects.not.toThrow(/operation is required/);
  });
});

describe('vikunja_projects schema - operation alias and parentProjectId 0', () => {
  function projectsSchema(): z.ZodObject<z.ZodRawShape> {
    const server = { tool: jest.fn() };
    const authManager = { isAuthenticated: jest.fn().mockReturnValue(true) };
    registerProjectsTool(server as never, authManager as never);
    return z.object(server.tool.mock.calls[0][2] as z.ZodRawShape);
  }

  it('parses operation', () => {
    expect(projectsSchema().parse({ operation: 'get', id: 5 })).toMatchObject({
      operation: 'get',
      id: 5,
    });
  });

  it('still parses subcommand', () => {
    expect(projectsSchema().parse({ subcommand: 'get', id: 5 })).toMatchObject({
      subcommand: 'get',
      id: 5,
    });
  });

  it('accepts parentProjectId 0 (Vikunja stores top level as 0)', () => {
    const parsed = projectsSchema().parse({ operation: 'update', id: 5, parentProjectId: 0 });

    expect(parsed.parentProjectId).toBe(0);
  });
});

describe('vikunja_task_comments - create / taskId aliasing', () => {
  let tasks: {
    createTaskComment: jest.Mock;
    getTaskComments: jest.Mock;
    updateTaskComment: jest.Mock;
  };
  let handler: ToolHandler;

  beforeEach(() => {
    jest.clearAllMocks();
    tasks = {
      createTaskComment: jest.fn(),
      getTaskComments: jest.fn(),
      updateTaskComment: jest.fn(),
    };
    tasks.createTaskComment.mockResolvedValue({ id: 1, task_id: 7, comment: 'x' });
    (getClientFromContext as jest.Mock).mockResolvedValue({ tasks });

    const server = { tool: jest.fn() };
    const authManager = { isAuthenticated: jest.fn().mockReturnValue(true) };
    registerTaskCommentsTool(server as never, authManager as never);
    handler = server.tool.mock.calls[0][3] as ToolHandler;
  });

  it('routes operation: create with taskId to the comment creation path', async () => {
    await handler({ operation: 'create', taskId: 7, comment: 'x' });

    expect(tasks.createTaskComment).toHaveBeenCalledWith(7, { task_id: 7, comment: 'x' });
  });

  it('still routes operation: comment with id the same way', async () => {
    const viaCreate = await handler({ operation: 'create', taskId: 7, comment: 'x' });
    tasks.createTaskComment.mockClear();
    const viaComment = await handler({ operation: 'comment', id: 7, comment: 'x' });

    expect(tasks.createTaskComment).toHaveBeenCalledWith(7, { task_id: 7, comment: 'x' });
    expect(viaComment).toEqual(viaCreate);
  });

  it('errors on the missing task id rather than crashing when neither id nor taskId is given', async () => {
    await expect(handler({ operation: 'create', comment: 'x' })).rejects.toThrow(
      'Task id is required',
    );
    expect(tasks.createTaskComment).not.toHaveBeenCalled();
  });

  it('schema accepts a call carrying only taskId', () => {
    const server = { tool: jest.fn() };
    const authManager = { isAuthenticated: jest.fn().mockReturnValue(true) };
    registerTaskCommentsTool(server as never, authManager as never);
    const schema = z.object(server.tool.mock.calls[0][2] as z.ZodRawShape);

    const parsed = schema.parse({ operation: 'create', taskId: 7, comment: 'x' });

    expect(parsed.taskId).toBe(7);
    expect(parsed.id).toBeUndefined();
  });
});

describe('vikunja_task_labels - short verb aliasing', () => {
  let tasks: {
    getTask: jest.Mock;
    updateTaskLabels: jest.Mock;
    removeLabelFromTask: jest.Mock;
  };
  let handler: ToolHandler;

  beforeEach(() => {
    jest.clearAllMocks();
    tasks = {
      getTask: jest.fn(),
      updateTaskLabels: jest.fn(),
      removeLabelFromTask: jest.fn(),
    };
    // The task already carries label 3 so apply-label's verification read
    // matches on the first try (no retry delays).
    tasks.getTask.mockResolvedValue({ id: 5, title: 'T', labels: [{ id: 3, title: 'shopping' }] });
    tasks.updateTaskLabels.mockResolvedValue({});
    tasks.removeLabelFromTask.mockResolvedValue({});
    (getClientFromContext as jest.Mock).mockResolvedValue({ tasks });

    const server = { tool: jest.fn() };
    const authManager = { isAuthenticated: jest.fn().mockReturnValue(true) };
    registerTaskLabelsTool(server as never, authManager as never);
    handler = server.tool.mock.calls[0][3] as ToolHandler;
  });

  it('routes apply the same as apply-label', async () => {
    const viaLong = await handler({ operation: 'apply-label', id: 5, labels: [3] });
    tasks.updateTaskLabels.mockClear();
    const viaShort = await handler({ operation: 'apply', id: 5, labels: [3] });

    expect(tasks.updateTaskLabels).toHaveBeenCalledWith(5, { label_ids: [3] });
    expect(viaShort).toEqual(viaLong);
  });

  it('routes remove the same as remove-label', async () => {
    const viaLong = await handler({ operation: 'remove-label', id: 5, labels: [3] });
    tasks.removeLabelFromTask.mockClear();
    const viaShort = await handler({ operation: 'remove', id: 5, labels: [3] });

    expect(tasks.removeLabelFromTask).toHaveBeenCalledWith(5, 3);
    expect(tasks.updateTaskLabels).not.toHaveBeenCalled();
    expect(viaShort).toEqual(viaLong);
  });

  it('routes list the same as list-labels', async () => {
    const viaLong = await handler({ operation: 'list-labels', id: 5 });
    const viaShort = await handler({ operation: 'list', id: 5 });

    expect(tasks.updateTaskLabels).not.toHaveBeenCalled();
    expect(viaShort).toEqual(viaLong);
    expect(viaShort.content[0].text).toContain('Task has 1 label(s)');
  });

  it('still routes bulk-apply-label to the bulk path', async () => {
    const result = await handler({
      operation: 'bulk-apply-label',
      taskIds: [5, 6],
      labels: [3],
    });

    expect(tasks.updateTaskLabels).toHaveBeenCalledTimes(2);
    expect(tasks.updateTaskLabels).toHaveBeenNthCalledWith(1, 5, { label_ids: [3] });
    expect(tasks.updateTaskLabels).toHaveBeenNthCalledWith(2, 6, { label_ids: [3] });
    expect(result.content[0].text).toContain('2/2 task');
  });
});
