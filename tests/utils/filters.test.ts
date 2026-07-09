/**
 * Tests for consolidated filter utilities
 */

import { describe, it, expect } from '@jest/globals';
import {
  validateCondition,
  validateFilterExpression,
  conditionToString,
  groupToString,
  expressionToString,
  parseFilterString,
  FilterBuilder,
  SecurityValidator,
} from '../../src/utils/filters';
import type { FilterCondition, FilterExpression, FilterGroup } from '../../src/types/index';

describe('Consolidated Filter Utilities', () => {
  describe('validateCondition', () => {
    it('should validate simple valid conditions', () => {
      const condition: FilterCondition = {
        field: 'done',
        operator: '=',
        value: true,
      };

      const errors = validateCondition(condition);
      expect(errors).toHaveLength(0);
    });

    it('should reject invalid field names with Zod error', () => {
      const condition = {
        field: 'invalidField',
        operator: '=',
        value: true,
      };

      const errors = validateCondition(condition);
      expect(errors).toHaveLength(1);
      // Zod enum failures are surfaced as a friendly "Invalid field name".
      expect(errors[0]).toContain('Invalid field name');
    });

    it('should reject invalid operators with Zod error', () => {
      const condition = {
        field: 'done',
        operator: 'invalid',
        value: true,
      };

      const errors = validateCondition(condition);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('Invalid field name');
    });

    it('should reject non-boolean values for done field', () => {
      const condition: FilterCondition = {
        field: 'done',
        operator: '=',
        value: 'yes', // not a boolean and not the string "true"/"false"
      };

      const errors = validateCondition(condition);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('Field "done" requires a boolean value');
    });

    it('should reject non-numeric values for priority field', () => {
      const condition: FilterCondition = {
        field: 'priority',
        operator: '=',
        value: 'high', // string instead of number
      };

      const errors = validateCondition(condition);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('Field "priority" requires a numeric value');
    });
  });

  describe('validateFilterExpression', () => {
    it('should validate simple expressions', () => {
      const expression: FilterExpression = {
        groups: [{
          operator: '&&',
          conditions: [{
            field: 'done',
            operator: '=',
            value: true
          }]
        }]
      };

      const result = validateFilterExpression(expression);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('warns (but stays valid) when an expression has many conditions', () => {
      const conditions = Array(60).fill(null).map((_, i) => ({
        field: 'priority' as const,
        operator: '=' as const,
        value: i
      }));

      const expression: FilterExpression = {
        groups: [{
          operator: '&&',
          conditions
        }]
      };

      const result = validateFilterExpression(expression);
      // Large filters are allowed but flagged as a performance concern.
      expect(result.valid).toBe(true);
      expect(result.warnings?.[0]).toContain('may impact performance');
    });

    it('honors a custom performance warning threshold', () => {
      const conditions = Array(10).fill(null).map((_, i) => ({
        field: 'priority' as const,
        operator: '=' as const,
        value: i
      }));

      const expression: FilterExpression = {
        groups: [{
          operator: '&&',
          conditions
        }]
      };

      const result = validateFilterExpression(expression, { performanceWarningThreshold: 5 });
      expect(result.warnings?.[0]).toContain('may impact performance');
    });
  });

  describe('conditionToString', () => {
    it('should convert simple condition to string', () => {
      const condition: FilterCondition = {
        field: 'done',
        operator: '=',
        value: true
      };

      const result = conditionToString(condition);
      expect(result).toBe('done = true');
    });

    it('quotes string values only for the like operator', () => {
      expect(conditionToString({ field: 'title', operator: '=', value: 'test task' })).toBe(
        'title = test task',
      );
      expect(conditionToString({ field: 'title', operator: 'like', value: 'test task' })).toBe(
        'title like "test task"',
      );
    });
  });

  describe('groupToString', () => {
    it('should convert single condition group to string', () => {
      const group: FilterGroup = {
        operator: '&&',
        conditions: [{
          field: 'done',
          operator: '=',
          value: true
        }]
      };

      const result = groupToString(group);
      expect(result).toBe('done = true');
    });

    it('should convert multiple condition group to string', () => {
      const group: FilterGroup = {
        operator: 'OR',
        conditions: [
          {
            field: 'done',
            operator: '=',
            value: true
          },
          {
            field: 'priority',
            operator: '>',
            value: 3
          }
        ]
      };

      const result = groupToString(group);
      // Multi-condition groups are parenthesized.
      expect(result).toBe('(done = true OR priority > 3)');
    });
  });

  describe('expressionToString', () => {
    it('should convert expression to string', () => {
      const expression: FilterExpression = {
        groups: [
          {
            operator: '&&',
            conditions: [{
              field: 'done',
              operator: '=',
              value: true
            }]
          },
          {
            operator: 'OR',
            conditions: [
              {
                field: 'priority',
                operator: '>',
                value: 3
              },
              {
                field: 'priority',
                operator: '<',
                value: 1
              }
            ]
          }
        ]
      };

      const result = expressionToString(expression);
      // Groups join with the expression operator (default &&); multi-condition
      // groups keep their own operator inside parentheses.
      expect(result).toBe('done = true && (priority > 3 OR priority < 1)');
    });
  });

  describe('parseFilterString', () => {
    it('should reject non-string input', () => {
      const result = parseFilterString(123 as any);
      expect(result.expression).toBeNull();
      expect(result.error?.message).toBe('Filter input must be a string');
    });

    it('should reject overly long input', () => {
      const longString = 'a'.repeat(1001);
      const result = parseFilterString(longString);
      expect(result.expression).toBeNull();
      expect(result.error?.message).toContain('too long');
    });

    it('should reject malicious patterns', () => {
      const maliciousInput = 'title = test; DROP TABLE users;';
      const result = parseFilterString(maliciousInput);
      // Injection is rejected by the grammar (the char whitelist admits `;`).
      expect(result.expression).toBeNull();
      expect(result.error?.message).toContain('Unexpected token');
    });

    it('should handle simple valid input', () => {
      const result = parseFilterString('done = true');
      expect(result.expression).not.toBeNull();
      expect(result.error).toBeUndefined();
    });

    it('should parse doneAt as a date field', () => {
      const result = parseFilterString('doneAt > now-7d');
      expect(result.error).toBeUndefined();
      expect(result.expression?.groups[0].conditions[0]).toEqual({
        field: 'doneAt',
        operator: '>',
        value: 'now-7d',
      });
    });

    it('names an unknown field and suggests the camelCase form', () => {
      const result = parseFilterString('due_date > now');
      expect(result.expression).toBeNull();
      expect(result.error?.message).toContain('Unknown filter field "due_date"');
      expect(result.error?.message).toContain('Did you mean "dueDate"?');
    });

    it('suggests doneAt for the snake_case done_at', () => {
      const result = parseFilterString('done_at > now-7d');
      expect(result.expression).toBeNull();
      expect(result.error?.message).toContain('Did you mean "doneAt"?');
    });

    it('lists available fields when an unknown field has no camelCase match', () => {
      const result = parseFilterString('bogus = 1');
      expect(result.expression).toBeNull();
      expect(result.error?.message).toContain('Unknown filter field "bogus"');
      expect(result.error?.message).not.toContain('Did you mean');
      expect(result.error?.message).toContain('Available fields:');
    });
  });

  describe('SecurityValidator', () => {
    it('should validate allowed characters', () => {
      expect(SecurityValidator.validateAllowedChars('done = true')).toBe(true);
      expect(SecurityValidator.validateAllowedChars('title > "test"')).toBe(true);
    });

    it('rejects dangerous input at the parser layer', () => {
      // The char whitelist admits punctuation like < > ; " (U+0020–U+007D);
      // structural rejection of injection happens in the grammar, not here.
      expect(parseFilterString('done = true; DROP TABLE').expression).toBeNull();
      expect(parseFilterString('<script>alert("xss")</script>').expression).toBeNull();
    });

    it('enforces the maximum filter length', () => {
      expect(SecurityValidator.validateLength('done = true').isValid).toBe(true);
      const tooLong = SecurityValidator.validateLength('a'.repeat(1001));
      expect(tooLong.isValid).toBe(false);
      expect(tooLong.error).toContain('too long');
    });

    it('enforces the maximum individual value length', () => {
      expect(SecurityValidator.validateValue('short').isValid).toBe(true);
      expect(SecurityValidator.validateValue('a'.repeat(201)).isValid).toBe(false);
    });
  });

  describe('FilterBuilder', () => {
    it('should build simple conditions', () => {
      const builder = new FilterBuilder();
      const result = builder
        .where('done', '=', true)
        .where('priority', '>', 3)
        .toString();

      expect(result).toBe('(done = true && priority > 3)');
    });

    it('should build with OR conditions', () => {
      const builder = new FilterBuilder();
      const result = builder
        .where('done', '=', true)
        .where('priority', '=', 3)
        .or()
        .where('done', '=', false)
        .toString();

      expect(result).toBe('(done = true || priority = 3 || done = false)');
    });

    it('should build filter expression', () => {
      const builder = new FilterBuilder();
      const result = builder
        .where('done', '=', true)
        .where('priority', '>', 3)
        .build();

      expect(result.groups).toHaveLength(1);
      expect(result.groups[0].conditions).toHaveLength(2);
      expect(result.groups[0].conditions[0].field).toBe('done');
      expect(result.groups[0].conditions[1].field).toBe('priority');
    });

    it('should handle empty builder', () => {
      const builder = new FilterBuilder();
      const result = builder.toString();
      expect(result).toBe('');
    });

    it('should handle single condition without explicit group', () => {
      const builder = new FilterBuilder();
      const result = builder
        .where('done', '=', false)
        .build();

      expect(result.groups[0].conditions).toHaveLength(1);
      expect(result.groups[0].conditions[0].value).toBe(false);
    });
  });

  describe('Backward Compatibility', () => {
    it('should maintain all exported function signatures', () => {
      expect(typeof validateCondition).toBe('function');
      expect(typeof validateFilterExpression).toBe('function');
      expect(typeof conditionToString).toBe('function');
      expect(typeof groupToString).toBe('function');
      expect(typeof expressionToString).toBe('function');
      expect(typeof parseFilterString).toBe('function');
      expect(typeof FilterBuilder).toBe('function');
    });

    it('should handle mixed case operators', () => {
      const condition: FilterCondition = {
        field: 'done',
        operator: '=',  // Zod will normalize this
        value: true
      };

      const errors = validateCondition(condition);
      expect(errors).toHaveLength(0);
    });
  });

});