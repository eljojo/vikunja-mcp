import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { updateTask } from '../../src/tools/tasks/crud/TaskUpdateService';
import { getClientFromContext } from '../../src/client';

jest.mock('../../src/client', () => ({
  getClientFromContext: jest.fn(),
  setGlobalClientFactory: jest.fn(),
}));

describe('updateTask - edit modes, date clearing and done-column move', () => {
  let service: {
    getTask: jest.Mock;
    updateTask: jest.Mock;
    moveTaskToBucket: jest.Mock;
    getBucketsForView: jest.Mock;
    getProjectViews: jest.Mock;
  };

  /** The whole rendered payload, so an assertion never depends on chunking. */
  function renderedText(result: { content: Array<{ type: 'text'; text: string }> }): string {
    return result.content.map((part) => part.text).join('\n');
  }

  /**
   * updateTask reads the task twice: once up front (the body a patch/append is
   * computed against) and once after the write (what Vikunja actually stored).
   */
  function stubGetTask(current: Record<string, unknown>, stored: Record<string, unknown>): void {
    service.getTask.mockReset();
    service.getTask.mockResolvedValueOnce(current).mockResolvedValue(stored);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    service = {
      getTask: jest.fn(),
      updateTask: jest.fn().mockResolvedValue({}),
      moveTaskToBucket: jest.fn().mockResolvedValue({}),
      getBucketsForView: jest.fn().mockResolvedValue([]),
      getProjectViews: jest.fn().mockResolvedValue([]),
    };
    (getClientFromContext as jest.Mock).mockResolvedValue({ tasks: service });
  });

  describe('previousState is opt-in', () => {
    const current = { id: 1, title: 'T', project_id: 5, description: '<p>old body</p>' };
    const stored = { id: 1, title: 'T', project_id: 5, description: '<p>new body</p>' };

    it('does not echo the previous values by default', async () => {
      stubGetTask(current, stored);

      const text = renderedText(await updateTask({ id: 1, description: '<p>new body</p>' }));

      expect(text).not.toContain('previousState');
      expect(text).not.toContain('old body');
      expect(text).toContain('affectedFields');
    });

    it('echoes the previous values when returnPrevious is true', async () => {
      stubGetTask(current, stored);

      const text = renderedText(
        await updateTask({ id: 1, description: '<p>new body</p>', returnPrevious: true }),
      );

      expect(text).toContain('previousState');
      expect(text).toContain('<p>old body</p>');
      expect(text).toContain('affectedFields');
    });
  });

  describe('editMode: patch', () => {
    it('rewrites in place and keeps the surrounding markup intact', async () => {
      const patched = '<p>Buy <strong>oat milk</strong> today</p>';
      stubGetTask(
        { id: 2, title: 'T', project_id: 5, description: '<p>Buy <strong>milk</strong> today</p>' },
        { id: 2, title: 'T', project_id: 5, description: patched },
      );

      await updateTask({ id: 2, editMode: 'patch', findText: 'milk', replaceText: 'oat milk' });

      expect(service.updateTask).toHaveBeenCalledWith(
        2,
        expect.objectContaining({ description: patched }),
      );
    });

    it('writes nothing and points at raw:true when findText matches nothing', async () => {
      stubGetTask(
        { id: 3, title: 'T', project_id: 5, description: '<p>Buy milk</p>' },
        { id: 3, title: 'T', project_id: 5, description: '<p>Buy milk</p>' },
      );

      await expect(
        updateTask({ id: 3, editMode: 'patch', findText: 'bread', replaceText: 'toast' }),
      ).rejects.toThrow('raw:true');
      expect(service.updateTask).not.toHaveBeenCalled();
    });

    it('explains that the text only exists in the rendered description', async () => {
      stubGetTask(
        { id: 4, title: 'T', project_id: 5, description: '<p>a <b>big</b> cat</p>' },
        { id: 4, title: 'T', project_id: 5, description: '<p>a <b>big</b> cat</p>' },
      );

      await expect(
        updateTask({ id: 4, editMode: 'patch', findText: 'a big cat', replaceText: 'a dog' }),
      ).rejects.toThrow('present in the rendered description but not in the stored HTML');
      expect(service.updateTask).not.toHaveBeenCalled();
    });

    it('treats a $ in the replacement as text, not as a substitution pattern', async () => {
      // String.replace would expand `$&` into the match itself.
      stubGetTask(
        { id: 7, title: 'T', project_id: 5, description: '<p>cost is TBD</p>' },
        { id: 7, title: 'T', project_id: 5, description: '<p>cost is $& $1 100</p>' },
      );

      await updateTask({ id: 7, editMode: 'patch', findText: 'TBD', replaceText: '$& $1 100' });

      expect(service.updateTask).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ description: '<p>cost is $& $1 100</p>' }),
      );
    });

    it('refuses an ambiguous match', async () => {
      stubGetTask(
        { id: 5, title: 'T', project_id: 5, description: '<p>cat and cat</p>' },
        { id: 5, title: 'T', project_id: 5, description: '<p>cat and cat</p>' },
      );

      await expect(
        updateTask({ id: 5, editMode: 'patch', findText: 'cat', replaceText: 'dog' }),
      ).rejects.toThrow('found 2 matches');
      expect(service.updateTask).not.toHaveBeenCalled();
    });

    it('replaces every occurrence with replaceAll', async () => {
      stubGetTask(
        { id: 5, title: 'T', project_id: 5, description: '<p>cat and cat</p>' },
        { id: 5, title: 'T', project_id: 5, description: '<p>dog and dog</p>' },
      );

      await updateTask({
        id: 5,
        editMode: 'patch',
        findText: 'cat',
        replaceText: 'dog',
        replaceAll: true,
      });

      expect(service.updateTask).toHaveBeenCalledWith(
        5,
        expect.objectContaining({ description: '<p>dog and dog</p>' }),
      );
    });

    it('requires findText', async () => {
      stubGetTask(
        { id: 6, title: 'T', project_id: 5, description: '<p>body</p>' },
        { id: 6, title: 'T', project_id: 5, description: '<p>body</p>' },
      );

      await expect(updateTask({ id: 6, editMode: 'patch', replaceText: 'x' })).rejects.toThrow(
        'editMode "patch" requires findText',
      );
      expect(service.updateTask).not.toHaveBeenCalled();
    });

    it('requires replaceText', async () => {
      stubGetTask(
        { id: 6, title: 'T', project_id: 5, description: '<p>body</p>' },
        { id: 6, title: 'T', project_id: 5, description: '<p>body</p>' },
      );

      await expect(updateTask({ id: 6, editMode: 'patch', findText: 'body' })).rejects.toThrow(
        'editMode "patch" requires replaceText',
      );
      expect(service.updateTask).not.toHaveBeenCalled();
    });
  });

  describe('editMode: append', () => {
    it('wraps bare prose in its own block before appending', async () => {
      const appended = '<p>first</p><p>second line</p>';
      stubGetTask(
        { id: 7, title: 'T', project_id: 5, description: '<p>first</p>' },
        { id: 7, title: 'T', project_id: 5, description: appended },
      );

      await updateTask({ id: 7, editMode: 'append', description: 'second line' });

      expect(service.updateTask).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ description: appended }),
      );
    });

    it('escapes prose so a literal < or & is stored as text, not markup', async () => {
      const appended = '<p>first</p><p>compare a &amp; b, and &lt;div&gt; tags</p>';
      stubGetTask(
        { id: 7, title: 'T', project_id: 5, description: '<p>first</p>' },
        { id: 7, title: 'T', project_id: 5, description: appended },
      );

      await updateTask({ id: 7, editMode: 'append', description: 'compare a & b, and <div> tags' });

      expect(service.updateTask).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ description: appended }),
      );
    });

    it('treats prose that merely contains an angle bracket as prose, not as HTML', async () => {
      // A loose "does it look like HTML" test would let this skip the <p> wrap,
      // and the line would be absorbed into the previous paragraph.
      const appended = '<p>first</p><p>compare &lt;b and c&gt; carefully</p>';
      stubGetTask(
        { id: 7, title: 'T', project_id: 5, description: '<p>first</p>' },
        { id: 7, title: 'T', project_id: 5, description: appended },
      );

      await updateTask({ id: 7, editMode: 'append', description: 'compare <b and c> carefully' });

      expect(service.updateTask).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ description: appended }),
      );
    });

    it('does not double-wrap markup that is already a block', async () => {
      const appended = '<p>first</p><ul><li>x</li></ul>';
      stubGetTask(
        { id: 7, title: 'T', project_id: 5, description: '<p>first</p>' },
        { id: 7, title: 'T', project_id: 5, description: appended },
      );

      await updateTask({ id: 7, editMode: 'append', description: '<ul><li>x</li></ul>' });

      expect(service.updateTask).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ description: appended }),
      );
    });
  });

  describe('dueDate', () => {
    const current = { id: 8, title: 'T', project_id: 5, due_date: '2026-01-01T10:00:00Z' };

    beforeEach(() => {
      stubGetTask(current, current);
    });

    it("treats '' as a clear, not a bad date", async () => {
      await updateTask({ id: 8, dueDate: '' });

      expect(service.updateTask).toHaveBeenCalledWith(
        8,
        expect.objectContaining({ due_date: '0001-01-01T00:00:00Z' }),
      );
    });

    it('treats null as a clear', async () => {
      await updateTask({ id: 8, dueDate: null });

      expect(service.updateTask).toHaveBeenCalledWith(
        8,
        expect.objectContaining({ due_date: '0001-01-01T00:00:00Z' }),
      );
    });

    it('still rejects a genuinely bad date', async () => {
      await expect(updateTask({ id: 8, dueDate: 'not-a-date' })).rejects.toThrow(
        'dueDate must be a valid ISO 8601 date string',
      );
      expect(service.updateTask).not.toHaveBeenCalled();
    });

    it('expands a date-only value to noon UTC', async () => {
      await updateTask({ id: 8, dueDate: '2026-07-14' });

      expect(service.updateTask).toHaveBeenCalledWith(
        8,
        expect.objectContaining({ due_date: '2026-07-14T12:00:00Z' }),
      );
    });
  });

  describe('done: true also closes the card on the board', () => {
    const current = { id: 42, title: 'T', project_id: 7, done: false };

    beforeEach(() => {
      stubGetTask(current, { ...current, done: true });
    });

    it("moves the card to the board's done column and verifies it landed", async () => {
      service.getProjectViews.mockResolvedValue([
        { id: 3, view_kind: 'list' },
        { id: 4, view_kind: 'kanban', done_bucket_id: 9 },
      ]);
      service.getBucketsForView.mockResolvedValue([{ id: 9, tasks: [{ id: 42 }] }]);

      const text = renderedText(await updateTask({ id: 42, done: true }));

      expect(service.moveTaskToBucket).toHaveBeenCalledWith(7, 4, 9, 42);
      expect(service.getBucketsForView).toHaveBeenCalledWith(7, 4);
      expect(text).toContain("moved to the board's done column (bucket 9)");
      // The card changed column, so a caller diffing affectedFields sees it
      expect(text).toContain('bucketId');
    });

    it('does nothing when the project has no kanban view', async () => {
      service.getProjectViews.mockResolvedValue([{ id: 3, view_kind: 'list' }]);

      const text = renderedText(await updateTask({ id: 42, done: true }));

      expect(service.moveTaskToBucket).not.toHaveBeenCalled();
      // Says why it didn't move rather than staying silent about it
      expect(text).toContain('has no Kanban view');
    });

    it('reports, without failing, when the board has no done column configured', async () => {
      service.getProjectViews.mockResolvedValue([
        { id: 4, view_kind: 'kanban', done_bucket_id: 0 },
      ]);

      const text = renderedText(await updateTask({ id: 42, done: true }));

      expect(service.moveTaskToBucket).not.toHaveBeenCalled();
      expect(text).toContain('has no done column configured');
    });

    it('treats a missing done_bucket_id the same way', async () => {
      service.getProjectViews.mockResolvedValue([{ id: 4, view_kind: 'kanban' }]);

      const text = renderedText(await updateTask({ id: 42, done: true }));

      expect(service.moveTaskToBucket).not.toHaveBeenCalled();
      expect(text).toContain('has no done column configured');
    });

    it('does not turn a landed done write into a failure when the views cannot be read', async () => {
      service.getProjectViews.mockRejectedValue(new Error('views unavailable'));

      const text = renderedText(await updateTask({ id: 42, done: true }));

      expect(service.updateTask).toHaveBeenCalledWith(42, expect.objectContaining({ done: true }));
      expect(service.moveTaskToBucket).not.toHaveBeenCalled();
      // Names the step that failed — reading the views — rather than claiming a
      // move was attempted and failed.
      expect(text).toContain('views could not be read');
      expect(text).toContain('the card was not moved');
    });

    it('does not claim the card stayed put when only the verification read failed', async () => {
      service.getProjectViews.mockResolvedValue([{ id: 4, view_kind: 'kanban', done_bucket_id: 9 }]);
      service.getBucketsForView.mockRejectedValue(new Error('board unavailable'));

      const text = renderedText(await updateTask({ id: 42, done: true }));

      // The move was issued and may well have landed; only the read-back failed.
      expect(service.moveTaskToBucket).toHaveBeenCalledWith(7, 4, 9, 42);
      expect(text).toContain('could not be verified');
      expect(text).not.toContain('still in its old column');
    });

    it('uses an explicitly passed viewId instead of resolving the kanban view', async () => {
      service.getProjectViews.mockResolvedValue([
        { id: 4, view_kind: 'kanban', done_bucket_id: 9 },
        { id: 6, view_kind: 'kanban', done_bucket_id: 11 },
      ]);
      service.getBucketsForView.mockResolvedValue([{ id: 11, tasks: [{ id: 42 }] }]);

      await updateTask({ id: 42, done: true, viewId: 6 });

      expect(service.moveTaskToBucket).toHaveBeenCalledWith(7, 6, 11, 42);
    });

    it('skips the move entirely when moveToDoneBucket is false', async () => {
      const text = renderedText(await updateTask({ id: 42, done: true, moveToDoneBucket: false }));

      expect(service.getProjectViews).not.toHaveBeenCalled();
      expect(service.moveTaskToBucket).not.toHaveBeenCalled();
      expect(text).not.toContain('done column');
    });

    it('lets an explicit bucket win, issuing only one move', async () => {
      service.getBucketsForView.mockResolvedValue([{ id: 15, tasks: [{ id: 42 }] }]);

      await updateTask({ id: 42, done: true, bucketId: 15, viewId: 12 });

      expect(service.moveTaskToBucket).toHaveBeenCalledTimes(1);
      expect(service.moveTaskToBucket).toHaveBeenCalledWith(7, 12, 15, 42);
      expect(service.getProjectViews).not.toHaveBeenCalled();
    });
  });

  describe('description read-back', () => {
    it('warns when the stored text differs from what was sent', async () => {
      stubGetTask(
        { id: 60, title: 'T', project_id: 5, description: '<p>before</p>' },
        { id: 60, title: 'T', project_id: 5, description: '<p>hello</p>' },
      );

      const text = renderedText(await updateTask({ id: 60, description: '<p>hello world</p>' }));

      expect(text).toContain('content was dropped or rewritten');
    });

    it('stays quiet when only the markup was normalised', async () => {
      stubGetTask(
        { id: 61, title: 'T', project_id: 5, description: '<p>before</p>' },
        { id: 61, title: 'T', project_id: 5, description: '<p>hi</p>\n' },
      );

      const text = renderedText(await updateTask({ id: 61, description: '<p>hi</p>' }));

      expect(text).not.toContain('content was dropped or rewritten');
    });
  });
});
