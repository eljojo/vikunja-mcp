import { ConfigurationManager } from '../config/ConfigurationManager';
import { DEFAULT_VERBOSITY_FIELDS, Verbosity } from './base';
import type { ResponseConfig } from '../config/types';

const REQUIRED_FIELDS = new Set(['id', 'title']);
const PROJECT_FIELDS: Record<Verbosity, string[]> = {
  [Verbosity.MINIMAL]: ['id', 'title', 'parent_project_id', 'children'],
  [Verbosity.STANDARD]: ['id', 'title', 'description', 'parent_project_id', 'is_archived', 'children'],
  [Verbosity.DETAILED]: [
    'id', 'title', 'description', 'parent_project_id', 'is_archived',
    'created', 'updated', 'owner', 'position', 'children',
  ],
  [Verbosity.COMPLETE]: [],
};

export function resolveResponseConfig(requestedVerbosity?: string): ResponseConfig {
  const configured = ConfigurationManager.getInstance().getResponseConfig();
  if (!requestedVerbosity) {
    return configured;
  }

  const verbosity = Object.values(Verbosity).includes(requestedVerbosity as Verbosity)
    ? requestedVerbosity as Verbosity
    : configured.verbosity;

  return { ...configured, verbosity };
}

export function applyResponseVerbosity<T>(data: T, config: ResponseConfig): T {
  return transformValue(data, config) as T;
}

function transformValue(value: unknown, config: ResponseConfig): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => transformValue(item, config));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const record = value as Record<string, unknown>;
  if (isEntity(record)) {
    return selectEntityFields(record, config);
  }

  return Object.fromEntries(
    Object.entries(record).map(([key, child]) => [key, transformValue(child, config)]),
  );
}

function isEntity(value: Record<string, unknown>): boolean {
  return typeof value.id === 'number' && typeof value.title === 'string';
}

function selectEntityFields(
  entity: Record<string, unknown>,
  config: ResponseConfig,
): Record<string, unknown> {
  const baseFields = config.verbosity === Verbosity.COMPLETE
    ? Object.keys(entity)
    : isProject(entity)
      ? PROJECT_FIELDS[config.verbosity]
      : [...DEFAULT_VERBOSITY_FIELDS[config.verbosity]];
  const included = new Set([...baseFields, ...config.includeFields, ...REQUIRED_FIELDS]);

  for (const field of config.excludeFields) {
    if (!REQUIRED_FIELDS.has(field)) {
      included.delete(field);
    }
  }

  return Object.fromEntries(
    Object.entries(entity)
      .filter(([field]) => included.has(field))
      .map(([field, child]) => [field, transformValue(child, config)]),
  );
}

function isProject(entity: Record<string, unknown>): boolean {
  return 'parent_project_id' in entity ||
    'is_archived' in entity ||
    Array.isArray(entity.children);
}
