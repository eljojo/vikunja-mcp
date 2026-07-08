import { describe, it, expect, jest } from '@jest/globals';
import { z } from 'zod';
import { registerProjectsTool } from '../../src/tools/projects';

/**
 * The MCP tool schema (not the handler) is what rejected a stringified numeric id
 * with "expected number, received string". These tests parse the real registered
 * schema to prove the identifier fields now coerce.
 */
function projectsSchema(): z.ZodObject<z.ZodRawShape> {
  const server = { tool: jest.fn() };
  const authManager = { isAuthenticated: jest.fn().mockReturnValue(true) };
  registerProjectsTool(server as never, authManager as never);
  const shape = server.tool.mock.calls[0][2] as z.ZodRawShape;
  return z.object(shape);
}

describe('vikunja_projects schema — identifier coercion', () => {
  it('coerces a string parentProjectId to a number', () => {
    const parsed = projectsSchema().parse({ subcommand: 'move', id: 5, parentProjectId: '7' });
    expect(parsed.parentProjectId).toBe(7);
  });

  it('coerces a string id to a number', () => {
    const parsed = projectsSchema().parse({ subcommand: 'get', id: '5' });
    expect(parsed.id).toBe(5);
  });

  it('coerces a string projectId to a number', () => {
    const parsed = projectsSchema().parse({ subcommand: 'list-shares', projectId: '9' });
    expect(parsed.projectId).toBe(9);
  });

  it('still passes null parentProjectId through without coercing it to 0', () => {
    const parsed = projectsSchema().parse({ subcommand: 'update', id: 1, parentProjectId: null });
    expect(parsed.parentProjectId).toBeNull();
  });
});
