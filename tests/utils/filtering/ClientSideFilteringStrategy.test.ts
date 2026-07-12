/**
 * Tests for ClientSideFilteringStrategy — the plain-browse windowed pager.
 * The server caps a page at 50, so a perPage above that must be filled by paging
 * 50-row chunks, and hasMore must reflect whether tasks exist beyond the window.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import type { Task } from 'node-vikunja';
import { ClientSideFilteringStrategy } from '../../../src/utils/filtering/ClientSideFilteringStrategy';
import type { FilteringParams } from '../../../src/utils/filtering/types';

jest.mock('../../../src/client', () => ({
  getClientFromContext: jest.fn(),
}));

jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { getClientFromContext } = require('../../../src/client');

const SERVER_CAP = 50;

/** A fake server that holds `total` tasks and caps every page at 50 rows. */
function fakeClient(total: number) {
  const backing: Task[] = Array.from({ length: total }, (_, i) => ({ id: i + 1, title: `t${i + 1}`, done: false }) as Task);
  const getAllTasks = jest.fn(async ({ page, per_page }: { page: number; per_page: number }) => {
    const size = Math.min(per_page, SERVER_CAP);
    return backing.slice((page - 1) * size, (page - 1) * size + size);
  });
  return { tasks: { getAllTasks, getProjectTasks: jest.fn() }, _getAllTasks: getAllTasks };
}

function browseParams(perPage: number, page = 1): FilteringParams {
  return {
    args: { allProjects: true, perPage, page },
    filterExpression: null,
    filterString: undefined,
    params: { per_page: perPage, page },
    loadAll: false,
  };
}

describe('ClientSideFilteringStrategy — browse window', () => {
  const strategy = new ClientSideFilteringStrategy();

  beforeEach(() => jest.clearAllMocks());

  it('fills a perPage above the server cap by paging 50-row chunks', async () => {
    const client = fakeClient(646);
    getClientFromContext.mockResolvedValue(client);

    const result = await strategy.execute(browseParams(100));

    expect(result.tasks).toHaveLength(100); // not truncated to the server's 50
    expect(result.tasks[0].id).toBe(1);
    expect(result.tasks[99].id).toBe(100);
    expect(result.metadata.hasMore).toBe(true);
    expect(client._getAllTasks).toHaveBeenCalledTimes(2); // 2 × 50
  });

  it('returns the right window for page 2', async () => {
    const client = fakeClient(646);
    getClientFromContext.mockResolvedValue(client);

    const result = await strategy.execute(browseParams(100, 2));

    expect(result.tasks.map((t) => t.id)[0]).toBe(101);
    expect(result.tasks).toHaveLength(100);
    expect(result.metadata.hasMore).toBe(true);
  });

  it('a single default page of 50 makes one call and flags more', async () => {
    const client = fakeClient(646);
    getClientFromContext.mockResolvedValue(client);

    const result = await strategy.execute(browseParams(50));

    expect(result.tasks).toHaveLength(50);
    expect(result.metadata.hasMore).toBe(true);
    expect(client._getAllTasks).toHaveBeenCalledTimes(1); // no over-fetch to detect more
  });

  it('reports hasMore=false when the set runs out inside the window', async () => {
    const client = fakeClient(30);
    getClientFromContext.mockResolvedValue(client);

    const result = await strategy.execute(browseParams(100));

    expect(result.tasks).toHaveLength(30);
    expect(result.metadata.hasMore).toBe(false);
  });
});
