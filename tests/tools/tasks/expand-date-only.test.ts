import { describe, it, expect } from '@jest/globals';
import { expandDateOnly } from '../../../src/tools/tasks/validation';

describe('expandDateOnly', () => {
  it('expands a bare calendar date to noon UTC (day-stable across timezones)', () => {
    // Vikunja rejects a date-only dueDate with an opaque "Invalid model provided".
    // Noon UTC keeps the calendar day the user typed intact everywhere from
    // UTC-11 to UTC+12 — a midnight-UTC expansion would slip west of UTC.
    expect(expandDateOnly('2026-07-14')).toBe('2026-07-14T12:00:00Z');
  });

  it('leaves a full RFC3339 timestamp untouched', () => {
    expect(expandDateOnly('2026-07-14T16:00:00Z')).toBe('2026-07-14T16:00:00Z');
  });

  it('leaves any string already carrying a time component untouched', () => {
    expect(expandDateOnly('2026-07-14T00:00:00+02:00')).toBe('2026-07-14T00:00:00+02:00');
  });
});
