import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { ConfigurationManager } from '../../src/config';
import {
  applyResponseVerbosity,
  resolveResponseConfig,
  Verbosity,
} from '../../src/transforms';

describe('response verbosity configuration', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    ConfigurationManager.reset();
    delete process.env.VIKUNJA_RESPONSE_VERBOSITY;
    delete process.env.VIKUNJA_RESPONSE_INCLUDE_FIELDS;
    delete process.env.VIKUNJA_RESPONSE_EXCLUDE_FIELDS;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    ConfigurationManager.reset();
  });

  it('loads global response settings from environment variables', () => {
    process.env.VIKUNJA_RESPONSE_VERBOSITY = 'detailed';
    process.env.VIKUNJA_RESPONSE_INCLUDE_FIELDS = 'hex_color, custom_field,hex_color';
    process.env.VIKUNJA_RESPONSE_EXCLUDE_FIELDS = 'description';

    expect(resolveResponseConfig()).toEqual({
      verbosity: Verbosity.DETAILED,
      includeFields: ['hex_color', 'custom_field'],
      excludeFields: ['description'],
    });
  });

  it('lets a request verbosity override the global default', () => {
    process.env.VIKUNJA_RESPONSE_VERBOSITY = 'minimal';

    expect(resolveResponseConfig('complete').verbosity).toBe(Verbosity.COMPLETE);
  });

  it('selects task fields and preserves required identity fields', () => {
    const task = {
      id: 1,
      title: 'Task',
      done: false,
      description: 'Details',
      priority: 3,
      due_date: '2026-06-10',
      hex_color: '#ffffff',
    };

    expect(applyResponseVerbosity(task, {
      verbosity: Verbosity.MINIMAL,
      includeFields: ['priority'],
      excludeFields: ['title'],
    })).toEqual({
      id: 1,
      title: 'Task',
      done: false,
      priority: 3,
    });
  });

  it('selects project fields without flattening response wrappers', () => {
    const data = {
      project: {
        id: 2,
        title: 'Project',
        description: 'Details',
        parent_project_id: 1,
        is_archived: false,
        hex_color: '#ffffff',
      },
      count: 1,
    };

    expect(applyResponseVerbosity(data, {
      verbosity: Verbosity.STANDARD,
      includeFields: [],
      excludeFields: [],
    })).toEqual({
      project: {
        id: 2,
        title: 'Project',
        description: 'Details',
        parent_project_id: 1,
        is_archived: false,
      },
      count: 1,
    });
  });

  it('preserves project tree structure at compact verbosity levels', () => {
    const tree = {
      id: 1,
      title: 'Root',
      children: [
        {
          id: 2,
          title: 'Child',
          parent_project_id: 1,
          children: [],
        },
      ],
    };

    expect(applyResponseVerbosity(tree, {
      verbosity: Verbosity.MINIMAL,
      includeFields: [],
      excludeFields: [],
    })).toEqual(tree);
  });
});
