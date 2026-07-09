import { describe, expect, it } from '@jest/globals';
import type { Task } from 'node-vikunja';
import { evaluateCondition } from '../../src/filters';

const task = (overrides: Partial<Task>): Task => ({ id: 1, title: 't', ...overrides }) as Task;

describe('evaluateCondition — doneAt', () => {
  it('matches a done task against a doneAt date comparison', () => {
    const t = task({ done: true, done_at: '2026-07-05T10:00:00Z' });
    expect(evaluateCondition(t, { field: 'doneAt', operator: '>', value: '2026-07-01' })).toBe(true);
    expect(evaluateCondition(t, { field: 'doneAt', operator: '<', value: '2026-07-01' })).toBe(false);
  });

  it('treats a task with no done_at as matching only !=', () => {
    const t = task({ done: false });
    expect(evaluateCondition(t, { field: 'doneAt', operator: '!=', value: '2026-07-01' })).toBe(true);
    expect(evaluateCondition(t, { field: 'doneAt', operator: '>', value: '2026-07-01' })).toBe(false);
  });
});
