/**
 * Tests for the vikunja_filters tool.
 *
 * CRUD actions operate on real Vikunja saved filters via the node-vikunja client
 * (mocked here). build/validate are pure filter-DSL helpers with no server call.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { registerFiltersTool } from '../../src/tools/filters';
import { getClientFromContext } from '../../src/client';
import type { MockServer } from '../types/mocks';
import type { AuthManager } from '../../src/auth/AuthManager';
import { parseMarkdown } from '../utils/markdown';

jest.mock('../../src/utils/logger');
jest.mock('../../src/client', () => ({
  getClientFromContext: jest.fn(),
}));

describe('vikunja_filters tool', () => {
  let toolHandler: (args: any) => Promise<any>;
  let mockServer: MockServer;
  let mockClient: {
    filters: {
      createFilter: jest.Mock;
      getFilter: jest.Mock;
      updateFilter: jest.Mock;
      deleteFilter: jest.Mock;
    };
    projects: { getProjects: jest.Mock };
  };

  beforeEach(() => {
    jest.clearAllMocks();

    mockClient = {
      filters: {
        createFilter: jest.fn(),
        getFilter: jest.fn(),
        updateFilter: jest.fn(),
        deleteFilter: jest.fn(),
      },
      projects: { getProjects: jest.fn() },
    };
    (getClientFromContext as jest.Mock).mockResolvedValue(mockClient as never);

    mockServer = {
      tool: jest.fn() as jest.MockedFunction<(name: string, schema: any, handler: any) => void>,
    } as MockServer;

    registerFiltersTool(mockServer, {} as AuthManager);

    const calls = (mockServer.tool as jest.Mock).mock.calls;
    if (calls.length > 0) {
      toolHandler = calls[0][3] as (args: any) => Promise<any>;
    } else {
      throw new Error('Tool handler not found');
    }
  });

  describe('list action', () => {
    it('lists saved filters from the negative-id pseudo-projects', async () => {
      mockClient.projects.getProjects.mockResolvedValue([
        { id: 1, title: 'Real project' },
        { id: -2, title: 'Shopping', description: 'all purchases', is_favorite: true },
        { id: -3, title: 'Publish', is_favorite: false },
      ]);

      const result = await toolHandler({ action: 'list', parameters: {} });
      const markdown = result.content[0].text;

      expect(markdown).toContain('## ✅ Success');
      expect(markdown).toContain('Found 2 saved filters');
      // -2 -> filter id 1, -3 -> filter id 2 (projectID = -filterID - 1)
    });

    it('filters the list by favorite', async () => {
      mockClient.projects.getProjects.mockResolvedValue([
        { id: -2, title: 'Shopping', is_favorite: true },
        { id: -3, title: 'Publish', is_favorite: false },
      ]);

      const result = await toolHandler({ action: 'list', parameters: { favorite: true } });
      expect(result.content[0].text).toContain('Found 1 saved filter');
    });

    it('returns zero filters when there are no pseudo-projects', async () => {
      mockClient.projects.getProjects.mockResolvedValue([{ id: 1, title: 'Real' }]);
      const result = await toolHandler({ action: 'list', parameters: {} });
      expect(result.content[0].text).toContain('Found 0 saved filters');
    });
  });

  describe('get action', () => {
    it('gets a filter and shows its query', async () => {
      mockClient.filters.getFilter.mockResolvedValue({
        id: 1,
        title: 'Shopping',
        description: 'all purchases',
        filters: { filter: 'labels in 5' },
        is_favorite: true,
      });

      const result = await toolHandler({ action: 'get', parameters: { id: 1 } });

      expect(mockClient.filters.getFilter).toHaveBeenCalledWith(1);
      expect(result.content[0].text).toContain('Retrieved filter "Shopping"');
    });

    it('surfaces a not-found error from the server', async () => {
      mockClient.filters.getFilter.mockRejectedValue(new Error('filter does not exist'));
      const result = await toolHandler({ action: 'get', parameters: { id: 999 } });
      const parsed = parseMarkdown(result.content[0].text);
      expect(parsed.hasHeading(2, /❌ Error/)).toBe(true);
    });
  });

  describe('create action', () => {
    it('creates a saved filter from a filter string, wrapping it under filters.filter', async () => {
      mockClient.filters.createFilter.mockResolvedValue({
        id: 4,
        title: 'Shopping',
        filters: { filter: 'labels in 5' },
      });

      const result = await toolHandler({
        action: 'create',
        parameters: { name: 'Shopping', filter: 'labels in 5', description: 'buy stuff' },
      });

      expect(mockClient.filters.createFilter).toHaveBeenCalledWith({
        title: 'Shopping',
        description: 'buy stuff',
        filters: { filter: 'labels in 5', filter_include_nulls: false },
      });
      expect(result.content[0].text).toContain('saved to Vikunja');
    });

    it('accepts title as an alias for name and isFavorite', async () => {
      mockClient.filters.createFilter.mockResolvedValue({ id: 5, title: 'Fav', filters: { filter: 'done = false' } });

      await toolHandler({
        action: 'create',
        parameters: { title: 'Fav', filter: 'done = false', isFavorite: true },
      });

      expect(mockClient.filters.createFilter).toHaveBeenCalledWith({
        title: 'Fav',
        filters: { filter: 'done = false', filter_include_nulls: false },
        is_favorite: true,
      });
    });

    it('builds the filter string from a structured filters object', async () => {
      mockClient.filters.createFilter.mockResolvedValue({ id: 6, title: 'Built', filters: { filter: 'priority >= 3' } });

      await toolHandler({
        action: 'create',
        parameters: {
          name: 'Built',
          filters: { filter_by: ['priority'], filter_value: ['3'], filter_comparator: ['>='] },
        },
      });

      const payload = mockClient.filters.createFilter.mock.calls[0][0] as { filters: { filter: string } };
      expect(payload.filters.filter).toContain('priority');
      expect(payload.filters.filter).toContain('3');
    });

    it('rejects a create with neither filter nor filters', async () => {
      const result = await toolHandler({ action: 'create', parameters: { name: 'Empty' } });
      const parsed = parseMarkdown(result.content[0].text);
      expect(parsed.hasHeading(2, /❌ Error/)).toBe(true);
      expect(mockClient.filters.createFilter).not.toHaveBeenCalled();
    });
  });

  describe('update action', () => {
    it('merges changes over the existing filter (keeps query when only title changes)', async () => {
      mockClient.filters.getFilter.mockResolvedValue({
        id: 1,
        title: 'Old',
        filters: { filter: 'labels in 5', filter_include_nulls: false },
        is_favorite: false,
      });
      mockClient.filters.updateFilter.mockResolvedValue({ id: 1, title: 'New', filters: { filter: 'labels in 5' } });

      await toolHandler({ action: 'update', parameters: { id: 1, name: 'New' } });

      const [id, payload] = mockClient.filters.updateFilter.mock.calls[0] as [number, any];
      expect(id).toBe(1);
      expect(payload.title).toBe('New');
      expect(payload.filters.filter).toBe('labels in 5'); // query preserved
    });

    it('replaces the query when a new filter string is given', async () => {
      mockClient.filters.getFilter.mockResolvedValue({
        id: 1,
        title: 'F',
        filters: { filter: 'labels in 5' },
      });
      mockClient.filters.updateFilter.mockResolvedValue({ id: 1, title: 'F', filters: { filter: 'done = true' } });

      await toolHandler({ action: 'update', parameters: { id: 1, filter: 'done = true' } });

      const payload = mockClient.filters.updateFilter.mock.calls[0][1] as any;
      expect(payload.filters.filter).toBe('done = true');
    });
  });

  describe('delete action', () => {
    it('deletes a filter by id', async () => {
      mockClient.filters.getFilter.mockResolvedValue({ id: 2, title: 'Gone', filters: { filter: 'done = true' } });
      mockClient.filters.deleteFilter.mockResolvedValue({ message: 'ok' });

      const result = await toolHandler({ action: 'delete', parameters: { id: 2 } });

      expect(mockClient.filters.deleteFilter).toHaveBeenCalledWith(2);
      expect(result.content[0].text).toContain('deleted');
    });
  });

  describe('build action (pure helper)', () => {
    it('builds a filter string from conditions', async () => {
      const result = await toolHandler({
        action: 'build',
        parameters: { conditions: [{ field: 'done', operator: '=', value: false }] },
      });
      expect(result.content[0].text).toContain('## ✅ Success');
      expect(mockClient.filters.createFilter).not.toHaveBeenCalled();
    });
  });

  describe('validate action (pure helper)', () => {
    it('validates a well-formed filter', async () => {
      const result = await toolHandler({ action: 'validate', parameters: { filter: 'done = false' } });
      expect(result.content[0].text).toContain('## ✅ Success');
    });

    it('rejects a malformed filter', async () => {
      const result = await toolHandler({ action: 'validate', parameters: { filter: 'this is (not valid' } });
      const parsed = parseMarkdown(result.content[0].text);
      expect(parsed.hasHeading(2, /❌ Error/)).toBe(true);
    });
  });

  describe('error handling', () => {
    it('formats server errors as an error response', async () => {
      mockClient.filters.createFilter.mockRejectedValue(new Error('boom'));
      const result = await toolHandler({
        action: 'create',
        parameters: { name: 'X', filter: 'done = false' },
      });
      const parsed = parseMarkdown(result.content[0].text);
      expect(parsed.hasHeading(2, /❌ Error/)).toBe(true);
      expect(result.content[0].text).toContain('boom');
    });
  });
});
