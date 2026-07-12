import { describe, expect, it } from '@jest/globals';
import type { Task } from 'node-vikunja';
import { evaluateCondition, applyFilter, parseFilterString } from '../../src/filters';

const task = (overrides: Partial<Task>): Task => ({ id: 1, title: 't', ...overrides }) as Task;

// Vikunja stores an unset date as the sentinel 0001-01-01T00:00:00Z, not null.
// Before the fix the evaluator treated it as a real year-1 date, so every
// dateless task matched `dueDate < <future>` and a filter could not narrow.
describe('evaluateCondition — zero-date sentinel', () => {
  const SENTINEL = '0001-01-01T00:00:00Z';

  it('treats the dueDate sentinel as "no date" (matches only !=)', () => {
    const t = task({ due_date: SENTINEL });
    expect(evaluateCondition(t, { field: 'dueDate', operator: '<', value: '2026-07-14' })).toBe(false);
    expect(evaluateCondition(t, { field: 'dueDate', operator: '<=', value: '2026-07-14' })).toBe(false);
    expect(evaluateCondition(t, { field: 'dueDate', operator: '=', value: '2026-07-14' })).toBe(false);
    expect(evaluateCondition(t, { field: 'dueDate', operator: '!=', value: '2026-07-14' })).toBe(true);
  });

  it('still compares a real due date normally', () => {
    const t = task({ due_date: '2026-07-01T00:00:00Z' });
    expect(evaluateCondition(t, { field: 'dueDate', operator: '<', value: '2026-07-14' })).toBe(true);
    expect(evaluateCondition(t, { field: 'dueDate', operator: '>', value: '2026-07-14' })).toBe(false);
  });

  it('treats the doneAt sentinel as "no date"', () => {
    const t = task({ done_at: SENTINEL });
    expect(evaluateCondition(t, { field: 'doneAt', operator: '<', value: '2026-07-14' })).toBe(false);
    expect(evaluateCondition(t, { field: 'doneAt', operator: '!=', value: '2026-07-14' })).toBe(true);
  });

  it('a dueDate filter narrows a mixed set instead of matching every dateless task', () => {
    const tasks = [
      task({ id: 1, done: false, due_date: '2026-07-01T00:00:00Z' }), // real, past → match
      task({ id: 2, done: false, due_date: '2026-08-01T00:00:00Z' }), // real, future → no
      task({ id: 3, done: false, due_date: SENTINEL }),               // no due date → no
      task({ id: 4, done: true, due_date: '2026-07-01T00:00:00Z' }),  // done → no
    ];
    const expr = parseFilterString('done = false && dueDate < "2026-07-14"').expression!;
    expect(applyFilter(tasks, expr).map((t) => t.id)).toEqual([1]);
  });
});
