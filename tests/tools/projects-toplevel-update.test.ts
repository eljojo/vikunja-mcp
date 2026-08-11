import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { updateProject } from '../../src/tools/projects/crud';
import { moveProject } from '../../src/tools/projects/hierarchy';
import { getClientFromContext } from '../../src/client';

jest.mock('../../src/client', () => ({
  getClientFromContext: jest.fn(),
  setGlobalClientFactory: jest.fn(),
}));

/**
 * Regression: a real Vikunja returns `parent_project_id: 0` (the Go zero value) for a
 * top-level project. The old update path re-validated that STORED value as if the caller
 * had supplied it, so `validateId(0, 'parentProjectId')` rejected every top-level update
 * with "parentProjectId must be a positive integer" — naming an argument nobody sent.
 * These mocks therefore use 0, not `undefined`, for "no parent".
 */
describe('vikunja_projects update — a stored parent_project_id of 0 means top level', () => {
  let projects: {
    getProject: jest.Mock;
    getProjects: jest.Mock;
    updateProject: jest.Mock;
  };

  const topLevel = {
    id: 1,
    title: 'Inbox',
    description: 'Everything unsorted',
    parent_project_id: 0,
    is_archived: false,
    hex_color: '#4287f5',
  };

  const child = {
    id: 7,
    title: 'Groceries',
    description: 'weekly list',
    parent_project_id: 42,
    is_archived: false,
    hex_color: '',
  };

  function firstText(result: { content: Array<{ type: string; text: string }> }): string {
    return result.content[0]?.text ?? '';
  }

  beforeEach(() => {
    jest.clearAllMocks();
    projects = {
      getProject: jest.fn(),
      getProjects: jest.fn(),
      updateProject: jest.fn(),
    };
    (getClientFromContext as jest.Mock).mockResolvedValue({ projects });
  });

  it('updates the title of a top-level project without complaining about parentProjectId', async () => {
    projects.getProject.mockResolvedValue(topLevel);
    projects.updateProject.mockResolvedValue({ ...topLevel, title: 'Inbox v2' });

    const result = await updateProject({ id: 1, title: 'Inbox v2' });

    expect(firstText(result)).toContain('updated successfully');
    // The caller supplied no parent, so there is nothing to look up or validate.
    expect(projects.getProjects).not.toHaveBeenCalled();
  });

  it('still sends the full writable snapshot, including parent_project_id 0', async () => {
    projects.getProject.mockResolvedValue(topLevel);
    projects.updateProject.mockResolvedValue({ ...topLevel, description: 'inbox, zero' });

    await updateProject({ id: 1, description: 'inbox, zero' });

    // Vikunja's update behaves like a model replacement: omitted MCP arguments must be
    // re-sent from the stored project or they are wiped.
    expect(projects.updateProject).toHaveBeenCalledWith(1, {
      title: 'Inbox',
      description: 'inbox, zero',
      parent_project_id: 0,
      is_archived: false,
      hex_color: '#4287f5',
    });
  });

  it('re-asserts a child project’s stored parent on a partial update', async () => {
    projects.getProject.mockResolvedValue(child);
    projects.updateProject.mockResolvedValue({ ...child, description: 'monthly list' });

    await updateProject({ id: 7, description: 'monthly list' });

    expect(projects.updateProject).toHaveBeenCalledWith(7, {
      title: 'Groceries',
      description: 'monthly list',
      parent_project_id: 42,
      is_archived: false,
      hex_color: '',
    });
    expect(projects.getProjects).not.toHaveBeenCalled();
  });

  it('fails loudly when the server drops the child project’s parent', async () => {
    projects.getProject.mockResolvedValue(child);
    projects.updateProject.mockResolvedValue({
      ...child,
      description: 'monthly list',
      parent_project_id: 0,
    });

    await expect(updateProject({ id: 7, description: 'monthly list' })).rejects.toThrow(
      'Project 7 update could not be verified',
    );
  });

  it('still validates an explicitly supplied non-zero parentProjectId', async () => {
    projects.getProject.mockResolvedValue(topLevel);
    projects.getProjects.mockResolvedValue([topLevel, child]);

    await expect(updateProject({ id: 1, parentProjectId: 99 })).rejects.toThrow(
      'Parent project with ID 99 not found',
    );
    expect(projects.updateProject).not.toHaveBeenCalled();
  });

  it('treats an explicit null parentProjectId as a move to top level and sends 0', async () => {
    projects.getProject.mockResolvedValue(child);
    projects.updateProject.mockResolvedValue({ ...child, parent_project_id: 0 });

    await updateProject({ id: 7, parentProjectId: null });

    expect(projects.updateProject).toHaveBeenCalledWith(7, {
      title: 'Groceries',
      description: 'weekly list',
      parent_project_id: 0,
      is_archived: false,
      hex_color: '',
    });
    expect(projects.getProjects).not.toHaveBeenCalled();
  });

  describe('move', () => {
    beforeEach(() => {
      projects.getProject.mockResolvedValue(child);
      projects.getProjects.mockResolvedValue([
        { id: 42, title: 'Home', parent_project_id: 0 },
        child,
      ]);
    });

    it('treats parentProjectId 0 as a move to root, not an invalid id', async () => {
      projects.updateProject.mockResolvedValue({ ...child, parent_project_id: 0 });

      const result = await moveProject({ id: 7, parentProjectId: 0 }, undefined);

      expect(projects.updateProject).toHaveBeenCalledWith(7, { parent_project_id: 0 });
      expect(firstText(result)).toContain('to root level');
    });

    it('still rejects a negative parentProjectId', async () => {
      await expect(moveProject({ id: 7, parentProjectId: -1 }, undefined)).rejects.toThrow(
        'parentProjectId must be a positive integer',
      );
      expect(projects.updateProject).not.toHaveBeenCalled();
    });
  });
});
