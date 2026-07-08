/**
 * Tests for Vikunja saved-filter helpers.
 */

import { describe, it, expect, jest } from '@jest/globals';
import {
  filterIdFromProjectId,
  projectIdFromFilterId,
  savedFilterQuery,
  resolveSavedFilterQuery,
} from '../../src/utils/saved-filters';
import { MCPError } from '../../src/types';

describe('saved-filters helpers', () => {
  describe('id conversion (projectID = -filterID - 1)', () => {
    it('round-trips filter id <-> pseudo-project id', () => {
      expect(projectIdFromFilterId(1)).toBe(-2);
      expect(filterIdFromProjectId(-2)).toBe(1);
      expect(filterIdFromProjectId(projectIdFromFilterId(7))).toBe(7);
    });
  });

  describe('savedFilterQuery', () => {
    it('reads the nested filter DSL string', () => {
      expect(savedFilterQuery({ title: 'x', filters: { filter: 'done = false' } } as never)).toBe('done = false');
    });

    it('returns undefined when there is no query', () => {
      expect(savedFilterQuery({ title: 'x', filters: {} } as never)).toBeUndefined();
    });
  });

  describe('resolveSavedFilterQuery', () => {
    const clientWith = (filter: unknown) =>
      ({ filters: { getFilter: jest.fn<() => Promise<unknown>>().mockResolvedValue(filter) } } as never);

    it('resolves a filter id to its query string', async () => {
      const client = clientWith({ id: 1, title: 'Shopping', filters: { filter: 'labels in 5' } });
      await expect(resolveSavedFilterQuery(client, 1)).resolves.toBe('labels in 5');
    });

    it('accepts a numeric-string id', async () => {
      const client = clientWith({ id: 2, title: 'X', filters: { filter: 'done = true' } });
      await expect(resolveSavedFilterQuery(client, '2')).resolves.toBe('done = true');
    });

    it('throws on a non-numeric id', async () => {
      const client = clientWith({});
      await expect(resolveSavedFilterQuery(client, 'abc')).rejects.toThrow(MCPError);
    });

    it('throws when the filter has no query', async () => {
      const client = clientWith({ id: 3, title: 'Empty', filters: {} });
      await expect(resolveSavedFilterQuery(client, 3)).rejects.toThrow(/not found or has no query/);
    });
  });
});
