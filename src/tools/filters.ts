import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthManager } from '../auth/AuthManager';
import type { VikunjaClientFactory } from '../client/VikunjaClientFactory';
import type { SavedFilter as VikunjaSavedFilter } from 'node-vikunja';
import { getClientFromContext } from '../client';
import { filterIdFromProjectId } from '../utils/saved-filters';
import {
  FilterBuilder,
  validateFilterExpression,
  parseFilterString,
  type FilterField,
  type FilterOperator,
} from '../filters';
import { logger } from '../utils/logger';
import { createStandardResponse } from '../types';
import { ErrorCode, MCPError, type FilterValue } from '../types';
import { createValidationError } from '../utils/error-handler';
import { formatAorpAsMarkdown } from '../utils/response-factory';
import { createAorpErrorResponse } from '../utils/response-factory';

/**
 * Schema for listing filters
 */
const ListFiltersSchema = z.object({
  favorite: z.boolean().optional().describe('Show only favorite filters'),
});

/**
 * Schema for getting a filter
 */
const GetFilterSchema = z.object({
  id: z.union([z.string(), z.number()]).describe('Saved filter ID'),
});

/**
 * Schema for creating a filter
 */
const CreateFilterSchema = z.object({
  name: z.string().optional().describe('Filter name'),
  title: z.string().optional().describe('Filter title (alias for name)'),
  description: z.string().optional().describe('Filter description'),
  filter: z.string().optional().describe('Filter query string (Vikunja filter DSL)'),
  filters: z.object({
    filter_by: z.array(z.string()).optional(),
    filter_value: z.array(z.string()).optional(),
    filter_comparator: z.array(z.string()).optional(),
    filter_concat: z.string().optional(),
  }).optional().describe('Filter conditions object (alternative to a filter string)'),
  isFavorite: z.boolean().optional().describe('Show the filter in the Favorites pseudo-project'),
  is_favorite: z.boolean().optional().describe('Alias for isFavorite'),
}).refine(data => (data.name || data.title) && (data.filter || data.filters), {
  message: 'Either name or title must be provided, and either filter or filters must be provided'
});

/**
 * Schema for updating a filter
 */
const UpdateFilterSchema = z.object({
  id: z.union([z.string(), z.number()]).describe('Saved filter ID'),
  name: z.string().optional().describe('New filter name'),
  title: z.string().optional().describe('New filter title (alias for name)'),
  description: z.string().optional().describe('New filter description'),
  filter: z.string().optional().describe('New filter query string'),
  isFavorite: z.boolean().optional().describe('Show the filter in the Favorites pseudo-project'),
  is_favorite: z.boolean().optional().describe('Alias for isFavorite'),
});

/**
 * Schema for deleting a filter
 */
const DeleteFilterSchema = z.object({
  id: z.union([z.string(), z.number()]).describe('Saved filter ID'),
});

/**
 * Schema for building a filter
 */
const BuildFilterSchema = z.object({
  conditions: z
    .array(
      z.object({
        field: z.enum([
          'done',
          'priority',
          'percentDone',
          'dueDate',
          'assignees',
          'labels',
          'created',
          'updated',
          'title',
          'description',
        ] as const),
        operator: z.enum(['=', '!=', '>', '>=', '<', '<=', 'like', 'in', 'not in'] as const),
        value: z.union([
          z.string(),
          z.number(),
          z.boolean(),
          z.array(z.union([z.string(), z.number()])),
        ]),
      }),
    )
    .describe('Filter conditions'),
  groupOperator: z.enum(['&&', '||']).optional().describe('Operator to combine conditions'),
});

/**
 * Schema for validating a filter
 */
const ValidateFilterSchema = z.object({
  filter: z.string().describe('Filter query string to validate'),
});

/**
 * Shape returned to the caller for a saved filter. `filter` is the Vikunja filter-DSL
 * string the saved filter wraps (nested under `filters.filter` on the wire).
 */
function filterView(filter: VikunjaSavedFilter): Record<string, unknown> {
  return {
    id: filter.id,
    title: filter.title,
    description: filter.description,
    filter: (filter.filters as { filter?: string } | undefined)?.filter,
    is_favorite: filter.is_favorite,
    created: filter.created,
    updated: filter.updated,
  };
}

/** Build the Vikunja SavedFilter payload from a query string + metadata. */
function toSavedFilterPayload(fields: {
  title: string;
  filter: string;
  description?: string | undefined;
  isFavorite?: boolean | undefined;
}): VikunjaSavedFilter {
  return {
    title: fields.title,
    filters: { filter: fields.filter, filter_include_nulls: false },
    ...(fields.description !== undefined && { description: fields.description }),
    ...(fields.isFavorite !== undefined && { is_favorite: fields.isFavorite }),
  } as VikunjaSavedFilter;
}

/** Compose a Vikunja filter-DSL string from the structured `filters` builder object. */
function buildFilterStringFromConditions(filters: {
  filter_by?: string[] | undefined;
  filter_value?: string[] | undefined;
  filter_comparator?: string[] | undefined;
  filter_concat?: string | undefined;
}): string {
  const builder = new FilterBuilder();
  const { filter_by, filter_value, filter_comparator, filter_concat } = filters;

  if (filter_by && filter_value && filter_comparator) {
    const conditions: Array<{ field: FilterField; operator: FilterOperator; value: FilterValue }> = [];

    for (let i = 0; i < filter_by.length; i++) {
      const field = filter_by[i];
      const value = filter_value?.[i];
      const comparator = filter_comparator?.[i];

      if (!value || !field || !comparator) continue;

      const validField = field as FilterField;
      const validComparator = comparator as FilterOperator;

      let typedValue: string | number | boolean = value;
      if (validField === 'priority' || validField === 'percentDone') {
        typedValue = Number(value);
      } else if (validField === 'done') {
        typedValue = value === 'true';
      }

      conditions.push({ field: validField, operator: validComparator, value: typedValue });
    }

    if (conditions.length > 0) {
      const firstCondition = conditions[0];
      if (firstCondition) {
        builder.where(firstCondition.field, firstCondition.operator, firstCondition.value);
      }
      for (let i = 1; i < conditions.length; i++) {
        const condition = conditions[i];
        if (condition) {
          if (filter_concat === '||') {
            builder.or();
          } else {
            builder.and();
          }
          builder.where(condition.field, condition.operator, condition.value);
        }
      }
    }
  }

  return builder.toString();
}

/**
 * Register filters tool.
 *
 * `list`/`get`/`create`/`update`/`delete` operate on real Vikunja saved filters (the
 * `/filters` endpoint), so filters created here sync to the Vikunja web app and mobile.
 * `build`/`validate` are pure helpers for composing and checking a filter-DSL string.
 */
export function registerFiltersTool(server: McpServer, _authManager: AuthManager, _clientFactory?: VikunjaClientFactory): void {
  server.tool(
    'vikunja_filters',
    'Manage Vikunja saved filters (synced to web + mobile) and build/validate filter query strings',
    {
      action: z.enum(['list', 'get', 'create', 'update', 'delete', 'build', 'validate']),
      parameters: z.record(z.unknown()),
    },
    async ({ action, parameters }) => {
      logger.info(`Executing vikunja_filters action: ${action}`);

      try {
        switch (action) {
          case 'list': {
            const params = ListFiltersSchema.parse(parameters);
            const client = await getClientFromContext();

            // Saved filters surface as negative-id pseudo-projects in the projects list.
            const projects = await client.projects.getProjects();
            const filterProjects = (projects || []).filter(
              (p) => typeof p.id === 'number' && p.id < 0,
            );

            let filters = filterProjects.map((p) => ({
              id: filterIdFromProjectId(p.id as number),
              title: p.title,
              description: p.description,
              is_favorite: p.is_favorite,
            }));

            if (params.favorite !== undefined) {
              filters = filters.filter((f) => Boolean(f.is_favorite) === params.favorite);
            }

            const response = createStandardResponse(
              'list-saved-filters',
              `Found ${filters.length} saved filter${filters.length !== 1 ? 's' : ''}`,
              { filters },
              { count: filters.length },
            );

            return { content: [{ type: 'text' as const, text: formatAorpAsMarkdown(response) }] };
          }

          case 'get': {
            const params = GetFilterSchema.parse(parameters);
            const client = await getClientFromContext();

            const filter = await client.filters.getFilter(Number(params.id));

            const response = createStandardResponse(
              'get-saved-filter',
              `Retrieved filter "${filter.title}"`,
              { filter: filterView(filter) },
            );

            return { content: [{ type: 'text' as const, text: formatAorpAsMarkdown(response) }] };
          }

          case 'create': {
            const params = CreateFilterSchema.parse(parameters);
            const client = await getClientFromContext();

            // Schema guarantees name or title is present.
            const title = (params.name ?? params.title) as string;

            let filterString = params.filter;
            if (!filterString && params.filters) {
              filterString = buildFilterStringFromConditions(params.filters);
            }
            if (!filterString) {
              throw createValidationError('No filter conditions provided');
            }

            const payload = toSavedFilterPayload({
              title,
              filter: filterString,
              ...(params.description !== undefined && { description: params.description }),
              ...((params.isFavorite ?? params.is_favorite) !== undefined && {
                isFavorite: params.isFavorite ?? params.is_favorite,
              }),
            });

            const filter = await client.filters.createFilter(payload);

            const response = createStandardResponse(
              'create-saved-filter',
              `Filter "${filter.title}" saved to Vikunja`,
              { filter: filterView(filter) },
            );

            return { content: [{ type: 'text' as const, text: formatAorpAsMarkdown(response) }] };
          }

          case 'update': {
            const params = UpdateFilterSchema.parse(parameters);
            const client = await getClientFromContext();

            // Vikunja's update replaces the whole saved filter, so fetch and merge.
            const existing = await client.filters.getFilter(Number(params.id));

            const title = params.name ?? params.title;
            const isFavorite = params.isFavorite ?? params.is_favorite;
            const currentQuery = (existing.filters as { filter?: string } | undefined)?.filter ?? '';

            const merged = {
              ...existing,
              ...(title !== undefined && { title }),
              ...(params.description !== undefined && { description: params.description }),
              ...(isFavorite !== undefined && { is_favorite: isFavorite }),
              filters: {
                ...(existing.filters as Record<string, unknown>),
                filter: params.filter !== undefined ? params.filter : currentQuery,
              },
            } as VikunjaSavedFilter;

            const filter = await client.filters.updateFilter(Number(params.id), merged);

            const affectedFields = [
              title !== undefined && 'title',
              params.description !== undefined && 'description',
              params.filter !== undefined && 'filter',
              isFavorite !== undefined && 'is_favorite',
            ].filter(Boolean) as string[];

            const response = createStandardResponse(
              'update-saved-filter',
              `Filter "${filter.title}" updated`,
              { filter: filterView(filter) },
              { affectedFields },
            );

            return { content: [{ type: 'text' as const, text: formatAorpAsMarkdown(response) }] };
          }

          case 'delete': {
            const params = DeleteFilterSchema.parse(parameters);
            const client = await getClientFromContext();

            // Fetch first so the confirmation names the filter and a missing id 404s clearly.
            const filter = await client.filters.getFilter(Number(params.id));
            await client.filters.deleteFilter(Number(params.id));

            const response = createStandardResponse(
              'delete-saved-filter',
              `Filter "${filter.title}" deleted`,
              { success: true },
            );

            return { content: [{ type: 'text' as const, text: formatAorpAsMarkdown(response) }] };
          }

          case 'build': {
            const params = BuildFilterSchema.parse(parameters);

            const builder = new FilterBuilder();
            params.conditions.forEach((condition, index) => {
              if (index > 0 && params.groupOperator === '||') {
                builder.or();
              }
              builder.where(condition.field, condition.operator, condition.value);
            });

            const filterString = builder.toString();

            const response = createStandardResponse(
              'build-filter',
              'Filter built successfully',
              { filter: filterString, valid: true, warnings: [] },
              { conditionCount: params.conditions.length },
            );

            return { content: [{ type: 'text' as const, text: formatAorpAsMarkdown(response) }] };
          }

          case 'validate': {
            const params = ValidateFilterSchema.parse(parameters);

            const parseResult = parseFilterString(params.filter);
            if (!parseResult.expression) {
              const errorMsg = parseResult.error?.message || 'Invalid filter syntax';
              throw createValidationError(`Invalid filter: ${errorMsg}`);
            }

            const validationResult = validateFilterExpression(parseResult.expression);

            const response = createStandardResponse(
              'validate-filter',
              validationResult.valid ? 'Filter is valid' : 'Filter validation failed',
              {
                valid: validationResult.valid,
                warnings: validationResult.warnings || [],
                errors: validationResult.errors || [],
                filter: params.filter,
              },
            );

            return { content: [{ type: 'text' as const, text: formatAorpAsMarkdown(response) }] };
          }

          default:
            throw new MCPError(ErrorCode.NOT_IMPLEMENTED, `Unknown action: ${action as string}`);
        }
      } catch (error) {
        logger.error(`Error in vikunja_filters tool:`, error);

        const operation = `${action}-filter`;
        const aorpErrorResult = createAorpErrorResponse(operation, error instanceof Error ? error.message : String(error));

        const compatibilityResult = {
          content: aorpErrorResult.content,
          immediate: {
            status: 'error' as const,
            key_insight: aorpErrorResult.content.split('\n')[0] || 'Error occurred',
            confidence: 0.0,
          },
          summary: aorpErrorResult.content.split('\n')[0] || 'Error occurred',
          metadata: {
            timestamp: aorpErrorResult.metadata?.timestamp || new Date().toISOString(),
            operation,
            success: false,
            ...(aorpErrorResult.metadata || {}),
          },
        };

        return {
          content: [{ type: 'text' as const, text: formatAorpAsMarkdown(compatibilityResult) }],
        };
      }
    },
  );
}
