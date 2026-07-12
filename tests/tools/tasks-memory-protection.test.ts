/**
 * Tests for memory protection in tasks module
 * Verifies DoS protection and task count limits
 */

import type { Task } from 'node-vikunja';
import { MCPError, ErrorCode } from '../../src/types';
import { registerTasksTool } from '../../src/tools/tasks';
import { getClientFromContext } from '../../src/client';
import { createMockTestableAuthManager } from '../utils/test-utils';
import type { MockVikunjaClient, MockAuthManager, MockServer } from '../types/mocks';

// Mock dependencies
jest.mock('../../src/client');
jest.mock('../../src/auth/AuthManager');
jest.mock('../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn()
  }
}));

const mockGetClientFromContext = getClientFromContext as jest.MockedFunction<typeof getClientFromContext>;

/** Build `n` tasks and an offset-aware getAllTasks that honors page/per_page. */
function offsetAwareBacking(n: number): { backing: Task[]; getAllTasks: jest.Mock } {
  const backing: Task[] = Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    title: `Task ${i + 1}`,
    description: '',
    done: false,
    priority: 0,
  })) as Task[];
  const getAllTasks = jest.fn((params: any) => {
    const size = params?.per_page ?? 50;
    const page = params?.page ?? 1;
    return Promise.resolve(backing.slice((page - 1) * size, (page - 1) * size + size));
  });
  return { backing, getAllTasks };
}

describe('Tasks Memory Protection', () => {
  let mockServer: MockServer;
  let mockAuthManager: MockAuthManager;
  let mockClient: MockVikunjaClient;
  let toolHandler: (args: any) => Promise<any>;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    jest.clearAllMocks();

    // Setup mock client
    mockClient = {
      getToken: jest.fn().mockReturnValue('test-token'),
      tasks: {
        getAllTasks: jest.fn(),
        getProjectTasks: jest.fn(),
        createTask: jest.fn(),
        getTask: jest.fn(),
        updateTask: jest.fn(),
        deleteTask: jest.fn(),
        getTaskComments: jest.fn(),
        createTaskComment: jest.fn(),
        updateTaskLabels: jest.fn(),
        bulkAssignUsersToTask: jest.fn(),
        removeUserFromTask: jest.fn(),
        bulkUpdateTasks: jest.fn(),
      },
      projects: {
        getProjects: jest.fn(),
        createProject: jest.fn(),
        getProject: jest.fn(),
        updateProject: jest.fn(),
        deleteProject: jest.fn(),
        createLinkShare: jest.fn(),
        getLinkShares: jest.fn(),
        getLinkShare: jest.fn(),
        deleteLinkShare: jest.fn(),
      },
      labels: {
        getLabels: jest.fn(),
        getLabel: jest.fn(),
        createLabel: jest.fn(),
        updateLabel: jest.fn(),
        deleteLabel: jest.fn(),
      },
      users: {
        getAll: jest.fn(),
      },
      teams: {
        getAll: jest.fn(),
        create: jest.fn(),
        delete: jest.fn(),
      },
      shares: {
        getShareAuth: jest.fn(),
      },
    };

    // Setup mock auth manager
    mockAuthManager = createMockTestableAuthManager();
    mockAuthManager.isAuthenticated.mockReturnValue(true);
    mockAuthManager.getSession.mockReturnValue({
      apiUrl: 'https://api.vikunja.test',
      apiToken: 'test-token',
      authType: 'api-token' as const,
      userId: 'test-user-123'
    });
    mockAuthManager.getAuthType.mockReturnValue('api-token');

    // Setup mock server
    mockServer = {
      tool: jest.fn() as jest.MockedFunction<(name: string, schema: any, handler: any) => void>,
    } as MockServer;

    mockGetClientFromContext.mockResolvedValue(mockClient);

    // Register the tool
    registerTasksTool(mockServer as any, mockAuthManager as any);

    // Get the tool handler
    expect(mockServer.tool).toHaveBeenCalledWith(
      'vikunja_tasks',
      expect.any(String),
      expect.any(Object),
      expect.any(Function),
    );
    const calls = mockServer.tool.mock.calls;
    if (calls.length > 0 && calls[0] && calls[0].length > 3) {
      toolHandler = calls[0][3];
    } else {
      throw new Error('Tool handler not found');
    }
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.clearAllMocks();
  });

  describe('Default Pagination Protection', () => {
    it('should apply default pagination when none specified', async () => {
      const mockTasks: Task[] = Array.from({ length: 50 }, (_, i) => ({
        id: i + 1,
        title: `Task ${i + 1}`,
        description: '',
        done: false,
        priority: 0
      })) as Task[];

      mockClient.tasks.getAllTasks.mockResolvedValue(mockTasks);

      const result = await toolHandler({
        subcommand: 'list'
      });

      expect(mockClient.tasks.getAllTasks).toHaveBeenCalledWith(
        expect.objectContaining({
          per_page: 50,
          page: 1
        })
      );

      expect(result.content[0].text).toContain('## ✅ Success');
    });

    it('respects user pagination by windowing 50-row server chunks', async () => {
      // The server caps a page at 50, so a browse pages 50-row chunks and slices
      // the requested (page, perPage) window rather than passing them through.
      const { getAllTasks } = offsetAwareBacking(60);
      mockClient.tasks.getAllTasks = getAllTasks;

      const result = await toolHandler({
        subcommand: 'list',
        page: 2,
        perPage: 25
      });

      // Server is fetched at its 50-row cap (page 1 covers rows 1-50, which the
      // pager slices to the page-2-of-25 window). Window contents themselves are
      // asserted in the ClientSideFilteringStrategy unit test.
      expect(getAllTasks).toHaveBeenCalledWith(
        expect.objectContaining({
          per_page: 50,
          page: 1
        })
      );
      expect(result.content[0].text).toContain('## ✅ Success');
    });
  });

  describe('Task Count Validation', () => {
    beforeEach(() => {
      process.env.VIKUNJA_MAX_TASKS_LIMIT = '100'; // Low limit for testing
    });

    it('should reject requests with perPage exceeding limits', async () => {
      await expect(
        toolHandler({
          subcommand: 'list',
          perPage: 200 // Exceeds limit of 100
        })
      ).rejects.toThrow(MCPError);

      // Should not call API if validation fails
      expect(mockClient.tasks.getAllTasks).not.toHaveBeenCalled();
    });

    it('should allow requests within limits', async () => {
      const mockTasks: Task[] = Array.from({ length: 50 }, (_, i) => ({
        id: i + 1,
        title: `Task ${i + 1}`,
        description: '',
        done: false,
        priority: 0
      })) as Task[];

      mockClient.tasks.getAllTasks.mockResolvedValue(mockTasks);

      const result = await toolHandler({
        subcommand: 'list',
        perPage: 50 // Within limit of 100
      });

      expect(mockClient.tasks.getAllTasks).toHaveBeenCalled();
      expect(result.content[0].text).toContain('## ✅ Success');
    });

    it('should provide helpful error message when limit exceeded', async () => {

      try {
        await toolHandler({
          subcommand: 'list',
          perPage: 150
        });
        fail('Expected error to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(MCPError);
        expect(error.code).toBe(ErrorCode.VALIDATION_ERROR);
        expect(error.message).toContain('Task count limit exceeded');
        expect(error.message).toContain('Requested: 150');
        expect(error.message).toContain('Max allowed: 100');
        expect(error.message).toContain('Estimated memory usage:');
        expect(error.message).toContain('risk:');
        expect(error.message).toContain('Reduce the perPage parameter');
      }
    });
  });

  describe('Post-Load Validation', () => {
    beforeEach(() => {
      process.env.VIKUNJA_MAX_TASKS_LIMIT = '100';
    });

    it('should warn when the full-load path exceeds recommended limits', async () => {
      // A full-load read (here: done filter) pages the whole set into memory, so
      // post-load validation is where an over-limit count is caught. 120 loaded
      // vs a recommended 100 → warn (but under the 1.5x hard limit → still succeeds).
      const { getAllTasks } = offsetAwareBacking(120);
      mockClient.tasks.getAllTasks = getAllTasks;

      const result = await toolHandler({
        subcommand: 'list',
        done: false, // forces a full-set load
        perPage: 50
      });

      // Should succeed but log warning
      expect(result.content[0].text).toContain('## ✅ Success');

      const mockLogger = require('../../src/utils/logger').logger;
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Loaded task count exceeds recommended limits',
        expect.objectContaining({
          actualCount: 120,
          maxRecommended: 100
        })
      );
    });

    it('should fail hard when the full-load path returns an extremely large dataset', async () => {
      // 200 loaded is past the 1.5x hard limit (150) → reject rather than process.
      const { getAllTasks } = offsetAwareBacking(200);
      mockClient.tasks.getAllTasks = getAllTasks;

      await expect(
        toolHandler({
          subcommand: 'list',
          done: false, // forces a full-set load
          perPage: 50
        })
      ).rejects.toThrow(MCPError);
    });
  });

  describe('Project-Specific Tasks', () => {
    beforeEach(() => {
      process.env.VIKUNJA_MAX_TASKS_LIMIT = '100';
    });

    it('should apply memory protection for project tasks', async () => {
      await expect(
        toolHandler({
          subcommand: 'list',
          projectId: 1,
          perPage: 150 // Exceeds limit
        })
      ).rejects.toThrow(MCPError);

      expect(mockClient.tasks.getProjectTasks).not.toHaveBeenCalled();
    });

    it('should work normally for project tasks within limits', async () => {
      const mockTasks: Task[] = Array.from({ length: 30 }, (_, i) => ({
        id: i + 1,
        title: `Project Task ${i + 1}`,
        description: '',
        done: false,
        priority: 0
      })) as Task[];

      mockClient.tasks.getProjectTasks.mockResolvedValue(mockTasks);

      const result = await toolHandler({
        subcommand: 'list',
        projectId: 1,
        perPage: 50
      });

      expect(mockClient.tasks.getProjectTasks).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          per_page: 50
        })
      );
      expect(result.content[0].text).toContain('## ✅ Success');
    });
  });

  describe('Memory Usage Logging', () => {
    beforeEach(() => {
      process.env.VIKUNJA_MAX_TASKS_LIMIT = '1000';
    });

    it('should log memory usage for task operations', async () => {
      const mockTasks: Task[] = Array.from({ length: 100 }, (_, i) => ({
        id: i + 1,
        title: `Task ${i + 1}`,
        description: 'A task description',
        done: false,
        priority: 1
      })) as Task[];

      mockClient.tasks.getAllTasks.mockResolvedValue(mockTasks);


      await toolHandler({
        subcommand: 'list',
        perPage: 100
      });

      const mockLogger = require('../../src/utils/logger').logger;
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Memory usage for task listing',
        expect.objectContaining({
          taskCount: 100,
          estimatedMemoryMB: expect.any(Number),
          maxTasksLimit: 1000
        })
      );
    });

    it('should warn when approaching memory limits', async () => {
      process.env.VIKUNJA_MAX_TASKS_LIMIT = '100';
      
      const mockTasks: Task[] = Array.from({ length: 85 }, (_, i) => ({
        id: i + 1,
        title: `Task ${i + 1}`,
        description: '',
        done: false,
        priority: 0
      })) as Task[];

      mockClient.tasks.getAllTasks.mockResolvedValue(mockTasks);


      await toolHandler({
        subcommand: 'list',
        perPage: 85
      });

      const mockLogger = require('../../src/utils/logger').logger;
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Approaching task limit: 85%'),
        expect.objectContaining({
          operation: 'task listing'
        })
      );
    });
  });

  describe('Environment Variable Configuration', () => {
    it('should respect custom memory limits from environment', async () => {
      process.env.VIKUNJA_MAX_TASKS_LIMIT = '50';

      await expect(
        toolHandler({
          subcommand: 'list',
          perPage: 75 // Exceeds custom limit of 50
        })
      ).rejects.toThrow(MCPError);
    });

    it('should handle invalid environment variable gracefully', async () => {
      process.env.VIKUNJA_MAX_TASKS_LIMIT = 'invalid_value';

      const mockTasks: Task[] = Array.from({ length: 50 }, (_, i) => ({
        id: i + 1,
        title: `Task ${i + 1}`,
        description: '',
        done: false,
        priority: 0
      })) as Task[];

      mockClient.tasks.getAllTasks.mockResolvedValue(mockTasks);


      // Should use default limit (10000) and succeed
      const result = await toolHandler({
        subcommand: 'list',
        perPage: 50
      });

      expect(result.content[0].text).toContain('## ✅ Success');
      
      const mockLogger = require('../../src/utils/logger').logger;
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Invalid VIKUNJA_MAX_TASKS_LIMIT value')
      );
    });
  });

  describe('Integration with Filtering', () => {
    beforeEach(() => {
      process.env.VIKUNJA_MAX_TASKS_LIMIT = '100';
    });

    it('should apply memory protection before filtering', async () => {
      await expect(
        toolHandler({
          subcommand: 'list',
          perPage: 150, // Exceeds limit
          filter: 'priority > 3' // Filter won't matter if we exceed memory limits first
        })
      ).rejects.toThrow(MCPError);

      expect(mockClient.tasks.getAllTasks).not.toHaveBeenCalled();
    });

    it('should work with filtering when within memory limits', async () => {
      const mockTasks: Task[] = Array.from({ length: 50 }, (_, i) => ({
        id: i + 1,
        title: `Task ${i + 1}`,
        description: '',
        done: false,
        priority: i % 5 + 1 // Priority 1-5
      })) as Task[];

      // With a filter present the code pages the full result set (loadAll),
      // stopping on a short page; return one full page then empty to terminate.
      mockClient.tasks.getAllTasks.mockResolvedValueOnce(mockTasks).mockResolvedValue([]);

      const result = await toolHandler({
        subcommand: 'list',
        perPage: 50,
        filter: 'priority > 3'
      });

      expect(mockClient.tasks.getAllTasks).toHaveBeenCalled();
      expect(result.content[0].text).toContain('## ✅ Success');
      expect(result.content[0].text).toContain('(filtered client-side)');
    });
  });
});