import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ServerSideFilteringStrategy } from '../../../src/utils/filtering/ServerSideFilteringStrategy';
import { getClientFromContext } from '../../../src/client';

jest.mock('../../../src/client', () => ({
  getClientFromContext: jest.fn(),
}));

/**
 * When the caller narrows further in memory (by bucket or done state), the
 * strategy must hand back the WHOLE match set — Vikunja caps a page at 50
 * however large per_page is, so a single request would give the narrowing a
 * truncated set that it would then report as complete.
 */
describe('ServerSideFilteringStrategy - full-load paging', () => {
  const SERVER_CAP = 50;
  let getProjectTasks: jest.Mock;

  const page = (n: number, size: number): Array<{ id: number }> =>
    Array.from({ length: size }, (_, i) => ({ id: (n - 1) * SERVER_CAP + i + 1 }));

  beforeEach(() => {
    jest.clearAllMocks();
    getProjectTasks = jest.fn();
    (getClientFromContext as jest.Mock).mockResolvedValue({ tasks: { getProjectTasks } });
  });

  const params = (loadAll: boolean): Record<string, unknown> => ({
    args: { projectId: 5 },
    filterExpression: null,
    filterString: 'done = false',
    params: { per_page: 1000, page: 1 },
    loadAll,
  });

  it('pages past the server cap and reports that it loaded everything', async () => {
    // 120 matches: two full 50-row pages then a short one.
    getProjectTasks
      .mockResolvedValueOnce(page(1, SERVER_CAP))
      .mockResolvedValueOnce(page(2, SERVER_CAP))
      .mockResolvedValueOnce(page(3, 20));

    const result = await new ServerSideFilteringStrategy().execute(params(true) as never);

    expect(result.tasks).toHaveLength(120);
    expect(getProjectTasks).toHaveBeenCalledTimes(3);
    // per_page is forced to the real cap; asking for 1000 would have got 50.
    expect(getProjectTasks).toHaveBeenNthCalledWith(
      1,
      5,
      expect.objectContaining({ per_page: SERVER_CAP, page: 1, filter: 'done = false' }),
    );
    expect(getProjectTasks).toHaveBeenNthCalledWith(3, 5, expect.objectContaining({ page: 3 }));
    // The flag is what lets the caller window the narrowed set truthfully.
    expect(result.metadata.loadedAll).toBe(true);
  });

  it('makes a single request, and claims nothing about completeness, for a plain filtered page', async () => {
    getProjectTasks.mockResolvedValue(page(1, 10));

    const result = await new ServerSideFilteringStrategy().execute(params(false) as never);

    expect(getProjectTasks).toHaveBeenCalledTimes(1);
    expect(result.metadata.loadedAll).toBeUndefined();
  });
});
