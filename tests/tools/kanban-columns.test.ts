import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { registerKanbanTool } from '../../src/tools/kanban';
import { getClientFromContext } from '../../src/client';

jest.mock('../../src/client', () => ({
  getClientFromContext: jest.fn(),
  setGlobalClientFactory: jest.fn(),
}));

type Handler = (
  args: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }> }>;

interface KanbanService {
  getProjectViews: jest.Mock;
  getViewBuckets: jest.Mock;
  getBucketsForView: jest.Mock;
  createBucket: jest.Mock;
  updateBucket: jest.Mock;
  deleteBucket: jest.Mock;
  updateView: jest.Mock;
  moveTaskToBucket: jest.Mock;
  updateTaskPosition: jest.Mock;
}

/**
 * applyTaskServiceCompatibility gates each helper on the method being present,
 * so a service missing e.g. `createBucket` makes getViewBuckets/updateBucket
 * throw "does not support bucket management" long before the tool logic runs.
 * Every key is therefore present whether or not a given test uses it.
 */
function makeService(): KanbanService {
  return {
    getProjectViews: jest.fn(),
    getViewBuckets: jest.fn(),
    getBucketsForView: jest.fn(),
    createBucket: jest.fn(),
    updateBucket: jest.fn(),
    deleteBucket: jest.fn(),
    updateView: jest.fn(),
    moveTaskToBucket: jest.fn(),
    updateTaskPosition: jest.fn(),
  };
}

function install(service: KanbanService): Handler {
  (getClientFromContext as jest.Mock).mockResolvedValue({ tasks: service });
  const authManager = { isAuthenticated: jest.fn().mockReturnValue(true) } as never;
  const server = { tool: jest.fn() };
  registerKanbanTool(server as never, authManager);
  return server.tool.mock.calls[0][3] as Handler;
}

/** Every request the tool could make, summed — used to prove a read costs nothing extra. */
function totalCalls(service: KanbanService): number {
  return Object.values(service).reduce((sum, fn) => sum + fn.mock.calls.length, 0);
}

const KANBAN_VIEW = {
  id: 2,
  project_id: 1,
  title: 'Kanban',
  view_kind: 'kanban',
  default_bucket_id: 10,
  done_bucket_id: 12,
};

describe('vikunja_kanban list-buckets - includeTasks', () => {
  let service: KanbanService;
  let handler: Handler;

  // Deliberately returned out of position order: the rendered order must come
  // from `position`, not from the order the server happened to hand them back.
  const columns = [
    { id: 12, title: 'Done', position: 196608 },
    { id: 10, title: 'Todo', position: 65536, limit: 0 },
    { id: 11, title: 'Doing', position: 131072, limit: 3 },
  ];
  const board = [
    { id: 12, title: 'Done', count: 0, tasks: [] },
    { id: 10, title: 'Todo', count: 2, tasks: [{ id: 101, title: 'Write spec' }, { id: 102, title: 'Review' }] },
    { id: 11, title: 'Doing', count: 1, tasks: [{ id: 103, title: 'Ship it' }] },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    service = makeService();
    service.getProjectViews.mockResolvedValue([KANBAN_VIEW]);
    service.getViewBuckets.mockResolvedValue(columns);
    service.getBucketsForView.mockResolvedValue(board);
    handler = install(service);
  });

  it('renders the plain column table unchanged, then one card table per column', async () => {
    const plain = await handler({ operation: 'list-buckets', projectId: 1, viewId: 2 });
    const expanded = await handler({
      operation: 'list-buckets',
      projectId: 1,
      viewId: 2,
      includeTasks: true,
    });

    const plainText = plain.content[0].text;
    const text = expanded.content[0].text;

    // The existing table is prefixed verbatim — includeTasks only appends.
    expect(plainText).toContain('| 11 | Doing | 1 | 3 |');
    expect(text.startsWith(plainText)).toBe(true);

    expect(text).toContain('### Todo (bucket 10) — 2 card(s)');
    expect(text).toContain('| ID | Task |');
    expect(text).toContain('| 101 | Write spec |');
    expect(text).toContain('| 103 | Ship it |');
    expect(text).toContain('### Done (bucket 12) — 0 card(s)');
  });

  it('lists the columns in the board position order, not the server response order', async () => {
    const result = await handler({
      operation: 'list-buckets',
      projectId: 1,
      viewId: 2,
      includeTasks: true,
    });
    const text = result.content[0].text;

    const todo = text.indexOf('### Todo (bucket 10)');
    const doing = text.indexOf('### Doing (bucket 11)');
    const done = text.indexOf('### Done (bucket 12)');
    expect(todo).toBeGreaterThan(-1);
    expect(todo).toBeLessThan(doing);
    expect(doing).toBeLessThan(done);
  });

  it('costs no extra API call over a plain list-buckets', async () => {
    await handler({ operation: 'list-buckets', projectId: 1, viewId: 2 });
    const afterPlain = totalCalls(service);

    await handler({ operation: 'list-buckets', projectId: 1, viewId: 2, includeTasks: true });
    const afterExpanded = totalCalls(service);

    // The board read already happened for the counts column; expanding it is free.
    expect(afterPlain).toBe(3);
    expect(afterExpanded - afterPlain).toBe(afterPlain);
    expect(service.getBucketsForView).toHaveBeenCalledTimes(2);
    expect(service.getViewBuckets).toHaveBeenCalledTimes(2);
  });

  it('says so when bucketId or taskLimit are passed without includeTasks', async () => {
    // Dropping them silently reads as "that column is empty".
    const result = await handler({ operation: 'list-buckets', projectId: 1, viewId: 2, bucketId: 20, taskLimit: 5 });
    const text = result.content[0].text;

    expect(text).toContain('bucketId and taskLimit only apply with includeTasks:true');
  });

  it('expands only the named column when bucketId is given', async () => {
    const result = await handler({
      operation: 'list-buckets',
      projectId: 1,
      viewId: 2,
      includeTasks: true,
      bucketId: 11,
    });
    const text = result.content[0].text;

    expect(text).toContain('### Doing (bucket 11) — 1 card(s)');
    expect(text).not.toContain('### Todo (bucket 10)');
    expect(text).not.toContain('### Done (bucket 12)');
    // The column table above it still lists every column.
    expect(text).toContain('| 10 | Todo |');
  });

  it('throws NOT_FOUND for a bucketId that is not in the view', async () => {
    await expect(
      handler({ operation: 'list-buckets', projectId: 1, viewId: 2, includeTasks: true, bucketId: 999 }),
    ).rejects.toThrow('Bucket 999 not found in view 2');
  });

  it('caps rendered rows at taskLimit and says it truncated', async () => {
    const result = await handler({
      operation: 'list-buckets',
      projectId: 1,
      viewId: 2,
      includeTasks: true,
      taskLimit: 1,
    });
    const text = result.content[0].text;

    expect(text).toContain('| 101 | Write spec |');
    expect(text).not.toContain('| 102 | Review |');
    expect(text).toContain('_Showing first 1 of 2. Pass bucketId and a higher taskLimit for the rest._');
  });
});

describe('vikunja_kanban list-buckets - default task caps', () => {
  let service: KanbanService;
  let handler: Handler;

  const cards = Array.from({ length: 130 }, (_, i) => ({ id: 1000 + i, title: `Card ${i + 1}` }));

  beforeEach(() => {
    jest.clearAllMocks();
    service = makeService();
    service.getProjectViews.mockResolvedValue([{ ...KANBAN_VIEW, default_bucket_id: 20 }]);
    service.getViewBuckets.mockResolvedValue([{ id: 20, title: 'Backlog', position: 65536 }]);
    service.getBucketsForView.mockResolvedValue([
      { id: 20, title: 'Backlog', count: 130, tasks: cards },
    ]);
    handler = install(service);
  });

  it('defaults to 20 cards per column for a whole board', async () => {
    const result = await handler({
      operation: 'list-buckets',
      projectId: 1,
      viewId: 2,
      includeTasks: true,
    });
    const text = result.content[0].text;

    expect(text).toContain('| Card 20 |');
    expect(text).not.toContain('| Card 21 |');
    expect(text).toContain('_Showing first 20 of 130. Pass bucketId and a higher taskLimit for the rest._');
  });

  it('defaults to 100 cards when one column is named', async () => {
    const result = await handler({
      operation: 'list-buckets',
      projectId: 1,
      viewId: 2,
      includeTasks: true,
      bucketId: 20,
    });
    const text = result.content[0].text;

    expect(text).toContain('| Card 100 |');
    expect(text).not.toContain('| Card 101 |');
    expect(text).toContain('_Showing first 100 of 130. Pass bucketId and a higher taskLimit for the rest._');
  });
});

describe('vikunja_kanban list-buckets - a short board read', () => {
  it('reports the server count, what the read returned and what was rendered', async () => {
    jest.clearAllMocks();
    const service = makeService();
    service.getProjectViews.mockResolvedValue([{ ...KANBAN_VIEW, default_bucket_id: 30 }]);
    service.getViewBuckets.mockResolvedValue([{ id: 30, title: 'Backlog', position: 65536 }]);
    // The server says 10 cards live here; the paging read only came back with 4.
    service.getBucketsForView.mockResolvedValue([
      {
        id: 30,
        title: 'Backlog',
        count: 10,
        tasks: [
          { id: 301, title: 'One' },
          { id: 302, title: 'Two' },
          { id: 303, title: 'Three' },
          { id: 304, title: 'Four' },
        ],
      },
    ]);
    const handler = install(service);

    const result = await handler({
      operation: 'list-buckets',
      projectId: 1,
      viewId: 2,
      includeTasks: true,
      taskLimit: 2,
    });
    const text = result.content[0].text;

    expect(text).toContain('### Backlog (bucket 30) — 10 card(s)');
    expect(text).toContain('_Board read returned 4 of 10 — the server stopped paging early._');
    expect(text).toContain('_Showing first 2 of 4. Pass bucketId and a higher taskLimit for the rest._');
  });
});

describe('vikunja_kanban list-buckets - markdown-hostile titles', () => {
  it('escapes pipes and folds newlines so the card table survives', async () => {
    jest.clearAllMocks();
    const service = makeService();
    service.getProjectViews.mockResolvedValue([{ ...KANBAN_VIEW, default_bucket_id: 20, done_bucket_id: 0 }]);
    service.getViewBuckets.mockResolvedValue([{ id: 20, title: 'Ideas | Inbox', position: 65536 }]);
    service.getBucketsForView.mockResolvedValue([
      {
        id: 20,
        title: 'Ideas | Inbox',
        count: 2,
        tasks: [
          { id: 201, title: 'Fix a|b pipe' },
          { id: 202, title: 'Line one\nLine two' },
        ],
      },
    ]);
    const handler = install(service);

    const result = await handler({
      operation: 'list-buckets',
      projectId: 1,
      viewId: 2,
      includeTasks: true,
    });
    const text = result.content[0].text;

    expect(text).toContain('### Ideas \\| Inbox (bucket 20) — 2 card(s)');
    expect(text).toContain('| 201 | Fix a\\|b pipe |');
    expect(text).toContain('| 202 | Line one / Line two |');
    // The raw newline would have split one row into two and broken the table.
    expect(text).not.toContain('Line one\nLine two');
    // The column table itself is escaped too — an unescaped pipe there would
    // put six cells in a five-column row and shift every value left.
    expect(text).toContain('| 20 | Ideas \\| Inbox | 2 |');
  });
});

describe('vikunja_kanban reorder-buckets', () => {
  let service: KanbanService;
  let handler: Handler;

  const existing = [
    { id: 12, title: 'Done', position: 196608, limit: 7 },
    { id: 10, title: 'Todo', position: 65536, limit: 0 },
    { id: 11, title: 'Doing', position: 131072, limit: 3 },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    service = makeService();
    service.getProjectViews.mockResolvedValue([KANBAN_VIEW]);
    service.getViewBuckets.mockResolvedValue(existing);
    service.updateBucket.mockResolvedValue({});
    handler = install(service);
  });

  it('writes position (i+1)*65536 and re-sends each moved column title and limit', async () => {
    service.getViewBuckets
      .mockResolvedValueOnce(existing)
      .mockResolvedValueOnce([
        { id: 10, title: 'Todo', position: 65536, limit: 0 },
        { id: 12, title: 'Done', position: 131072, limit: 7 },
        { id: 11, title: 'Doing', position: 196608, limit: 3 },
      ]);

    const result = await handler({
      operation: 'reorder-buckets',
      projectId: 1,
      viewId: 2,
      bucketIds: [10, 12, 11],
    });
    const text = result.content[0].text;

    // Todo is already at 65536 — that column is skipped, not rewritten.
    expect(service.updateBucket).toHaveBeenCalledTimes(2);
    expect(service.updateBucket).toHaveBeenNthCalledWith(1, 1, 2, 12, {
      title: 'Done',
      position: 131072,
      limit: 7,
    });
    expect(service.updateBucket).toHaveBeenNthCalledWith(2, 1, 2, 11, {
      title: 'Doing',
      position: 196608,
      limit: 3,
    });
    // A position-only POST would blank the title, so the title must be resent.
    for (const call of service.updateBucket.mock.calls) {
      expect((call[3] as { title?: string }).title).toBeDefined();
    }

    // Final order is read back from the board, not echoed from the request.
    expect(service.getViewBuckets).toHaveBeenCalledTimes(2);
    expect(text).toContain('1. Todo (10)\n2. Done (12)\n3. Doing (11)');
    expect(text).toContain('_2 column(s) repositioned, order read back from the board._');
  });

  it('refuses a list with duplicate ids and writes nothing', async () => {
    await expect(
      handler({ operation: 'reorder-buckets', projectId: 1, viewId: 2, bucketIds: [10, 10, 11, 12] }),
    ).rejects.toThrow('bucketIds lists 10 more than once. Nothing was changed.');

    expect(service.updateBucket).not.toHaveBeenCalled();
  });

  it('refuses an id that is not in the view and writes nothing', async () => {
    await expect(
      handler({ operation: 'reorder-buckets', projectId: 1, viewId: 2, bucketIds: [10, 11, 12, 99] }),
    ).rejects.toThrow('Bucket(s) 99 are not in view 2 (it has 10, 11, 12). Nothing was changed.');

    expect(service.updateBucket).not.toHaveBeenCalled();
  });

  it('refuses an incomplete order and writes nothing', async () => {
    await expect(
      handler({ operation: 'reorder-buckets', projectId: 1, viewId: 2, bucketIds: [10, 11] }),
    ).rejects.toThrow(
      'bucketIds must list every column in the view; 12 is missing. ' +
        'Pass the complete order (list-buckets shows it). Nothing was changed.',
    );

    expect(service.updateBucket).not.toHaveBeenCalled();
  });

  it('previews #from → #to under dryRun without writing', async () => {
    const result = await handler({
      operation: 'reorder-buckets',
      projectId: 1,
      viewId: 2,
      bucketIds: [12, 11, 10],
      dryRun: true,
    });
    const text = result.content[0].text;

    expect(service.updateBucket).not.toHaveBeenCalled();
    expect(text).toContain('## Dry run — reorder columns in project 1 (view 2)');
    expect(text).toContain('- "Done" (12): #3 → #1');
    expect(text).toContain('- "Doing" (11): #2 → #2');
    expect(text).toContain('- "Todo" (10): #1 → #3');
  });

  it('reports the order the board actually ended up in when a write fails partway', async () => {
    service.getViewBuckets
      .mockResolvedValueOnce(existing)
      .mockResolvedValueOnce([
        { id: 12, title: 'Done', position: 65536, limit: 7 },
        { id: 10, title: 'Todo', position: 98304, limit: 0 },
        { id: 11, title: 'Doing', position: 131072, limit: 3 },
      ]);
    service.updateBucket.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('nope'));

    // [12, 11, 10]: Done is written, Doing is already at 131072 (skipped), Todo blows up.
    await expect(
      handler({ operation: 'reorder-buckets', projectId: 1, viewId: 2, bucketIds: [12, 11, 10] }),
    ).rejects.toThrow(
      'Reorder failed partway: nope. 1 of 3 column(s) were repositioned. ' +
        'The board is now ordered: Done (12) | Todo (10) | Doing (11)',
    );

    expect(service.updateBucket).toHaveBeenCalledTimes(2);
    expect(service.getViewBuckets).toHaveBeenCalledTimes(2);
  });

  it('requires bucketIds', async () => {
    await expect(
      handler({ operation: 'reorder-buckets', projectId: 1, viewId: 2 }),
    ).rejects.toThrow('bucketIds (the complete column order, left to right) is required for reorder-buckets');

    expect(service.updateBucket).not.toHaveBeenCalled();
  });
});
