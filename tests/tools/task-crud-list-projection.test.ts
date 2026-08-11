import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { registerTaskCrudTool } from '../../src/tools/task-crud';
import { getClientFromContext } from '../../src/client';

jest.mock('../../src/client', () => ({
  getClientFromContext: jest.fn(),
  setGlobalClientFactory: jest.fn(),
}));

// The list path opens session-scoped filter storage; nothing here uses it.
jest.mock('../../src/storage/SimpleFilterStorage', () => ({
  storageManager: {
    getStorage: jest.fn().mockReturnValue({
      get: jest.fn(),
      save: jest.fn(),
      list: jest.fn(),
      delete: jest.fn(),
    }),
    clearAll: jest.fn(),
  },
}));

/**
 * `vikunja_task_crud list` is the board read a coordinator makes constantly, so
 * what it costs is the feature. These drive the REGISTERED handler (not the
 * filtering internals) to pin the shape a caller actually gets back.
 */
describe('vikunja_task_crud list - the cheap read', () => {
  type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

  let service: {
    getProjectTasks: jest.Mock;
    getAllTasks: jest.Mock;
    getProjectViews: jest.Mock;
    getBucketsForView: jest.Mock;
    getTaskComments: jest.Mock;
  };
  let handler: Handler;

  const task = (id: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id,
    project_id: 5,
    title: `Task ${id}`,
    description: `<p>A long researched body for ${id}</p>`,
    done: false,
    ...extra,
  });

  function install(): void {
    const server = { tool: jest.fn() };
    registerTaskCrudTool(
      server as never,
      { isAuthenticated: (): boolean => true, getSession: (): unknown => ({ apiUrl: 'x' }) } as never,
    );
    handler = server.tool.mock.calls[0]?.[3] as Handler;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    service = {
      getProjectTasks: jest.fn().mockResolvedValue([]),
      getAllTasks: jest.fn().mockResolvedValue([]),
      // Enrichment is best-effort; an empty board keeps these tests about the table.
      getProjectViews: jest.fn().mockResolvedValue([]),
      getBucketsForView: jest.fn().mockResolvedValue([]),
      getTaskComments: jest.fn().mockResolvedValue([]),
    };
    (getClientFromContext as jest.Mock).mockResolvedValue({
      tasks: service,
      projects: { getProjects: jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]) },
    });
    install();
  });

  it('leaves the description bodies out of a plain list', async () => {
    service.getProjectTasks.mockResolvedValue([task(1), task(2)]);

    const text = (await handler({ operation: 'list', projectId: 5 })).content[0]?.text ?? '';

    // The ✓ column shows because the query didn't pin done state
    expect(text).toContain('| ID | ✓ | Task |');
    expect(text).toContain('| 1 |  | Task 1 |');
    expect(text).toContain('| 2 |  | Task 2 |');
    // The whole point: bodies are what made a board read cost a quarter of a megabyte
    expect(text).not.toContain('A long researched body');
    expect(text).not.toContain('Notes');
  });

  it('brings the bodies back for verbose:true', async () => {
    service.getProjectTasks.mockResolvedValue([task(1)]);

    const text = (await handler({ operation: 'list', projectId: 5, verbose: true })).content[0]?.text ?? '';

    expect(text).toContain('Notes');
    expect(text).toContain('A long researched body for 1');
  });

  it('renders only the requested columns when fields pins the projection', async () => {
    service.getProjectTasks.mockResolvedValue([
      task(1, { priority: 5, due_date: '2026-08-20T12:00:00Z' }),
    ]);

    const text = (await handler({ operation: 'list', projectId: 5, fields: ['id', 'title'] })).content[0]?.text ?? '';

    expect(text).toContain('| ID | Task |');
    expect(text).not.toContain('| ✓ |');
    expect(text).not.toContain('Pri');
    expect(text).not.toContain('Due');
  });

  it('reports the page against the real match total when a filter narrows the set', async () => {
    // 12 matches, a 5-row window: the old behaviour returned all 12 and called
    // it "Found 12", with page 2 serving the same rows again.
    service.getProjectTasks.mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => task(100 + i, { priority: 5 })),
    );

    const page1 = (await handler({
      operation: 'list',
      projectId: 5,
      perPage: 5,
      filter: 'priority >= 5',
    })).content[0]?.text ?? '';

    expect(page1).toContain('Found 5 of 12 tasks');
    expect(page1).toContain('| 100 |  | Task 100 |');
    expect(page1).not.toContain('| 105 |');

    const page2 = (await handler({
      operation: 'list',
      projectId: 5,
      page: 2,
      perPage: 5,
      filter: 'priority >= 5',
    })).content[0]?.text ?? '';

    expect(page2).toContain('| 105 |  | Task 105 |');
    expect(page2).not.toContain('| 100 |  | Task 100 |');
    expect(page2).toContain('Page 2 of 3');
  });

  it('says "Found N tasks" without a total when the read was not narrowed', async () => {
    service.getProjectTasks.mockResolvedValue([task(1), task(2)]);

    const text = (await handler({ operation: 'list', projectId: 5 })).content[0]?.text ?? '';

    expect(text).toContain('Found 2 tasks');
    expect(text).not.toContain(' of ');
  });
});
