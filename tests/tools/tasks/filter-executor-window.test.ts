/**
 * Regression tests for the (page, perPage) window FilterExecutor applies after
 * client-side narrowing.
 *
 * A narrowed read (filter / done / bucket) has to load the COMPLETE set so the
 * narrowing sees everything — but the whole narrowed set used to come back, so
 * `perPage` did nothing and every `page` returned the same rows. The window is
 * applied after the narrowing, gated on the strategy reporting `loadedAll`: a
 * plain browse is already windowed by ClientSideFilteringStrategy.loadWindow and
 * must never be sliced twice.
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Task } from 'node-vikunja';

jest.mock('../../../src/client', () => ({
  getClientFromContext: jest.fn(),
}));

import { FilterExecutor } from '../../../src/tools/tasks/filtering';
import { ClientSideFilteringStrategy } from '../../../src/utils/filtering/ClientSideFilteringStrategy';
import type { FilteringParams } from '../../../src/utils/filtering/types';
import type { TaskListingArgs, TaskFilterExecutionResult } from '../../../src/tools/tasks/types/filters';

const { getClientFromContext } = require('../../../src/client');

const PROJECT_ID = 13;
const VIEW_ID = 52;
const TARGET_BUCKET = 39;
const OTHER_BUCKET = 38;
/** Vikunja caps a page at 50 rows however large per_page is. */
const SERVER_CAP = 50;

interface FakeTaskService {
  getProjectTasks: jest.Mock;
  getAllTasks: jest.Mock;
  getBucketsForView: jest.Mock;
}

interface FakeBucket {
  id: number;
  tasks: Task[];
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let id = from; id <= to; id++) {
    out.push(id);
  }
  return out;
}

function makeTask(id: number, done = false): Task {
  return { id, project_id: PROJECT_ID, title: `t${id}`, done, bucket_id: 0 } as Task;
}

function idsOf(tasks: Task[]): Array<number | undefined> {
  return tasks.map((task) => task.id);
}

/** A task service that paginates like the real server: never more than 50 rows. */
function fakeTaskService(backing: Task[], buckets: FakeBucket[]): FakeTaskService {
  const slicePage = (params?: { page?: number; per_page?: number }): Promise<Task[]> => {
    const size = Math.min(params?.per_page ?? SERVER_CAP, SERVER_CAP);
    const page = params?.page ?? 1;
    return Promise.resolve(backing.slice((page - 1) * size, page * size));
  };

  const service: FakeTaskService = {
    getProjectTasks: jest.fn(),
    getAllTasks: jest.fn(),
    getBucketsForView: jest.fn(),
  };
  service.getProjectTasks.mockImplementation((...args: unknown[]) =>
    slicePage(args[1] as { page?: number; per_page?: number } | undefined),
  );
  service.getAllTasks.mockImplementation((...args: unknown[]) =>
    slicePage(args[0] as { page?: number; per_page?: number } | undefined),
  );
  service.getBucketsForView.mockResolvedValue(buckets);
  return service;
}

/** Column of 75 cards, sitting behind 10 cards of another column in load order. */
const OTHER_COLUMN = range(1001, 1010).map((id) => makeTask(id));
const TARGET_COLUMN = range(1, 75).map((id) => makeTask(id));
const BOARD_BACKING = [...OTHER_COLUMN, ...TARGET_COLUMN]; // 85 rows => 2 server pages
const BOARD_BUCKETS: FakeBucket[] = [
  { id: OTHER_BUCKET, tasks: OTHER_COLUMN },
  { id: TARGET_BUCKET, tasks: TARGET_COLUMN },
];

/** 85 plain tasks with no bucket/done narrowing — the browse fixture. */
const FLAT_BACKING = range(1, 85).map((id) => makeTask(id));

function runListing(args: TaskListingArgs): Promise<TaskFilterExecutionResult> {
  return FilterExecutor.executeFiltering(
    args,
    null,
    undefined,
    FilterExecutor.prepareQueryParameters(args),
    {} as never,
  );
}

describe('FilterExecutor — windowing a client-side narrowed list', () => {
  let board: FakeTaskService;

  beforeEach(() => {
    jest.clearAllMocks();
    board = fakeTaskService(BOARD_BACKING, BOARD_BUCKETS);
    getClientFromContext.mockResolvedValue({ tasks: board });
  });

  function listColumn(args: Partial<TaskListingArgs>): Promise<TaskFilterExecutionResult> {
    return runListing({ projectId: PROJECT_ID, viewId: VIEW_ID, bucketId: TARGET_BUCKET, ...args });
  }

  it('returns only perPage rows from a column that holds more', async () => {
    const result = await listColumn({ page: 1, perPage: 12 });

    expect(idsOf(result.tasks)).toEqual(range(1, 12));
    expect(result.metadata.pagination).toEqual({
      page: 1,
      perPage: 12,
      returned: 12,
      hasMore: true,
      total: 75,
    });
    // The narrowing still saw the whole set: both server pages were read.
    expect(board.getProjectTasks).toHaveBeenCalledTimes(2);
  });

  it('returns the NEXT rows on page 2, not page 1 again', async () => {
    const first = await listColumn({ page: 1, perPage: 12 });
    const second = await listColumn({ page: 2, perPage: 12 });

    expect(idsOf(second.tasks)).toEqual(range(13, 24));
    expect(idsOf(second.tasks)).not.toEqual(idsOf(first.tasks));
    expect(idsOf(second.tasks).filter((id) => idsOf(first.tasks).includes(id))).toEqual([]);
    expect(second.metadata.pagination).toEqual({
      page: 2,
      perPage: 12,
      returned: 12,
      hasMore: true,
      total: 75,
    });
  });

  it('flags hasMore before the last page and clears it on the last', async () => {
    const secondToLast = await listColumn({ page: 6, perPage: 12 });
    const last = await listColumn({ page: 7, perPage: 12 });

    expect(idsOf(secondToLast.tasks)).toEqual(range(61, 72));
    expect(secondToLast.metadata.pagination?.hasMore).toBe(true);

    // 75 rows at 12 a page: the 7th page is the 3-row remainder, not a full page.
    expect(idsOf(last.tasks)).toEqual([73, 74, 75]);
    expect(last.metadata.pagination).toEqual({
      page: 7,
      perPage: 12,
      returned: 3,
      hasMore: false,
      total: 75,
    });
  });

  it('defaults to 50 per page when perPage is omitted and still reports the true total', async () => {
    const first = await listColumn({});
    const second = await listColumn({ page: 2 });

    expect(first.tasks).toHaveLength(50);
    expect(first.metadata.pagination).toEqual({
      page: 1,
      perPage: 50,
      returned: 50,
      hasMore: true,
      total: 75,
    });

    expect(idsOf(second.tasks)).toEqual(range(51, 75));
    expect(second.metadata.pagination).toEqual({
      page: 2,
      perPage: 50,
      returned: 25,
      hasMore: false,
      total: 75,
    });
  });

  it('falls back to the default page size when perPage is 0', async () => {
    const result = await listColumn({ perPage: 0 });

    expect(result.tasks).toHaveLength(50);
    expect(result.metadata.pagination).toEqual({
      page: 1,
      perPage: 50,
      returned: 50,
      hasMore: true,
      total: 75,
    });
  });

  it('falls back to the default page size when perPage is not a number', async () => {
    const result = await listColumn({ perPage: Number.NaN });

    expect(result.tasks).toHaveLength(50);
    expect(result.metadata.pagination?.perPage).toBe(50);
    expect(result.metadata.pagination?.total).toBe(75);
  });

  it('floors a fractional perPage instead of producing a NaN window', async () => {
    const result = await listColumn({ perPage: 12.7 });

    expect(idsOf(result.tasks)).toEqual(range(1, 12));
    expect(result.metadata.pagination?.perPage).toBe(12);
    expect(result.metadata.pagination?.returned).toBe(12);
  });

  it('treats a page below 1 as page 1', async () => {
    const result = await listColumn({ page: 0, perPage: 12 });

    expect(idsOf(result.tasks)).toEqual(range(1, 12));
    expect(result.metadata.pagination?.page).toBe(1);
  });

  it('windows a done-narrowed list the same way', async () => {
    const backing = range(1, 60).map((id) => makeTask(id, id > 20));
    getClientFromContext.mockResolvedValue({ tasks: fakeTaskService(backing, []) });

    const result = await runListing({ projectId: PROJECT_ID, done: false, page: 2, perPage: 8 });

    expect(idsOf(result.tasks)).toEqual(range(9, 16));
    expect(result.metadata.pagination).toEqual({
      page: 2,
      perPage: 8,
      returned: 8,
      hasMore: true,
      total: 20,
    });
  });
});

describe('FilterExecutor — a plain browse is not windowed twice', () => {
  let flat: FakeTaskService;

  beforeEach(() => {
    jest.clearAllMocks();
    flat = fakeTaskService(FLAT_BACKING, []);
    getClientFromContext.mockResolvedValue({ tasks: flat });
  });

  it('page 2 of an unnarrowed list still returns its window', async () => {
    const result = await runListing({ projectId: PROJECT_ID, page: 2, perPage: 12 });

    // loadWindow already returned rows 13-24; slicing again at offset 12 would empty it.
    expect(idsOf(result.tasks)).toEqual(range(13, 24));
    expect(result.metadata.pagination).toEqual({
      page: 2,
      perPage: 12,
      returned: 12,
      hasMore: true,
    });
    // Nothing counted the full set — a browse never reads past its window.
    expect(result.metadata.pagination?.total).toBeUndefined();
  });

  it('the final browse page returns its remainder rather than nothing', async () => {
    const result = await runListing({ projectId: PROJECT_ID, page: 8, perPage: 12 });

    expect(idsOf(result.tasks)).toEqual([85]);
    expect(result.metadata.pagination).toEqual({
      page: 8,
      perPage: 12,
      returned: 1,
      hasMore: false,
    });
  });
});

describe('ClientSideFilteringStrategy — the loadedAll signal the window is gated on', () => {
  const strategy = new ClientSideFilteringStrategy();

  function strategyParams(loadAll?: boolean): FilteringParams {
    const base: FilteringParams = {
      args: { projectId: PROJECT_ID, page: 1, perPage: 12 },
      filterExpression: null,
      filterString: undefined,
      params: { page: 1, per_page: 12 },
    };
    return loadAll === undefined ? base : { ...base, loadAll };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    getClientFromContext.mockResolvedValue({ tasks: fakeTaskService(FLAT_BACKING, []) });
  });

  it('reports loadedAll when the caller asked for the complete set', async () => {
    const result = await strategy.execute(strategyParams(true));

    expect(result.metadata.loadedAll).toBe(true);
    expect(result.tasks).toHaveLength(85); // the whole set, unwindowed
  });

  it('omits loadedAll for a plain windowed browse', async () => {
    const result = await strategy.execute(strategyParams());

    expect('loadedAll' in result.metadata).toBe(false);
    expect(result.metadata.loadedAll).toBeUndefined();
    expect(result.tasks).toHaveLength(12); // already windowed here
  });
});
