/**
 * Simple Response Formatter
 * Replaces the over-engineered 2,925-line AORP system with direct, clean responses
 */

import type { ResponseMetadata } from '../types/responses';
import type { Task, Project, Label, User } from '../types/vikunja';

/**
 * Common data structures that can be passed to response formatters
 */
export interface ResponseData {
  /** Array of items with common identifiers */
  items?: Array<{
    id?: number | string;
    title?: string;
    name?: string;
    [key: string]: unknown;
  }>;
  /** Tasks collection */
  tasks?: Task[];
  /** Projects collection */
  projects?: Project[];
  /** Labels collection */
  labels?: Label[];
  /** Users collection */
  users?: User[];
  /** Generic key-value data */
  [key: string]: unknown;
}

/**
 * Individual data item that can be formatted for display
 */
export interface DataItem {
  id?: number | string;
  title?: string;
  name?: string;
  [key: string]: unknown;
}

/**
 * Safety bound on how many collection items are rendered in one response.
 * The API paginates via page/perPage; this only prevents a single unfiltered
 * page from dumping an unbounded payload. Beyond it, callers narrow or page.
 */
const MAX_RENDERED_ITEMS = 100;

/**
 * Metadata keys suppressed from the success output. They are either redundant
 * with the ✅ header / message / rendered item (success, operation, timestamp,
 * taskId, count, verbosity) or filtering diagnostics only useful when
 * debugging. Errors keep full detail via formatErrorMessage.
 */
const SUPPRESSED_SUCCESS_METADATA_KEYS = new Set([
  'timestamp',
  'success',
  'operation',
  'taskId',
  'count',
  'verbosity',
  'filteringMethod',
  'filteringNote',
  'serverSideFilteringUsed',
  'serverSideFilteringAttempted',
  'clientSideFiltering',
  'pagination',
]);

/**
 * Pagination shape optionally carried on list metadata
 */
interface PaginationInfo {
  page: number;
  perPage: number;
  returned: number;
  hasMore: boolean;
}

/**
 * Rendering hints for task tables, passed on `data.taskTableOptions`.
 */
interface TaskTableOptions {
  /** Force-show (true) or hide (false) the done column; default: show when mixed */
  showDone?: boolean;
}

/**
 * Simple response structure - replaces complex AORP system
 */
export interface SimpleResponse {
  /** Response content */
  content: string;
  /** Response metadata */
  metadata?: ResponseMetadata;
}

/**
 * Create a simple success response
 * Replaces complex AORP factory with direct formatting
 */
export function createSuccessResponse(
  operation: string,
  message: string,
  data?: ResponseData,
  metadata?: ResponseMetadata
): SimpleResponse {
  const content = formatSuccessMessage(operation, message, data, metadata);

  return {
    content,
    metadata: {
      timestamp: new Date().toISOString(),
      success: true,
      operation,
      ...metadata,
    },
  };
}

/**
 * Create a simple error response
 * Replaces complex AORP error handling with direct formatting
 */
export function createErrorResponse(
  operation: string,
  message: string,
  errorCode: string = 'UNKNOWN_ERROR',
  metadata?: ResponseMetadata
): SimpleResponse {
  const content = formatErrorMessage(operation, message, errorCode, metadata);

  return {
    content,
    metadata: {
      timestamp: new Date().toISOString(),
      success: false,
      operation,
      error: {
        code: errorCode,
        message,
      },
      ...metadata,
    },
  };
}

/**
 * Format success message in clean markdown
 * Replaces complex AORP markdown formatting
 */
export function formatSuccessMessage(
  _operation: string,
  message: string,
  data?: ResponseData,
  metadata?: Record<string, unknown>
): string {
  let content = `## ✅ Success\n\n${message}\n\n`;

  // Pagination is surfaced in the collection footer, not the raw metadata dump.
  const pagination =
    metadata && typeof metadata === 'object'
      ? (metadata.pagination as PaginationInfo | undefined)
      : undefined;

  // Include metadata, minus redundant envelope noise (see suppressed set).
  if (metadata && typeof metadata === 'object') {
    const metadataEntries = Object.entries(metadata).filter(
      ([key, value]) =>
        value !== undefined && value !== null && !SUPPRESSED_SUCCESS_METADATA_KEYS.has(key),
    );
    if (metadataEntries.length > 0) {
      content += formatObjectData(Object.fromEntries(metadataEntries));
    }
  }

  if (data) {
    // Check for known collection types first
    const collection = data.tasks || data.projects || data.labels || data.users || data.items;
    const taskOptions = (data as Record<string, unknown>).taskTableOptions as
      | TaskTableOptions
      | undefined;

    if (collection && Array.isArray(collection)) {
      content += formatCollection(collection as DataItem[], pagination, taskOptions);
    } else if (Array.isArray(data)) {
      content += formatCollection(data as DataItem[], pagination, taskOptions);
    } else if (data && typeof data === 'object') {
      content += formatObjectData(data as Record<string, unknown>);
    }
  }

  return content;
}

/**
 * Format error message in clean markdown
 * Replaces complex AORP error formatting
 */
export function formatErrorMessage(
  operation: string,
  message: string,
  errorCode: string,
  metadata?: ResponseMetadata
): string {
  let output = `## ❌ Error\n\n${message}\n\n**Error Code:** ${errorCode}`;

  // Include important metadata fields in error output
  if (metadata) {
    // Add operation if different from default
    if (metadata.operation && metadata.operation !== operation) {
      output += `\n\n**Operation:** ${metadata.operation}`;
    }

    // Add failed IDs if present
    if (metadata.failedIds && Array.isArray(metadata.failedIds)) {
      output += `\n\n**FailedIds**:\n${JSON.stringify(metadata.failedIds)}`;
    }

    // Add failed count if present
    if (typeof metadata.failedCount === 'number') {
      output += `\n\n**FailedCount**:\n${metadata.failedCount}`;
    }

    // Add failures array if present
    if (metadata.failures && Array.isArray(metadata.failures)) {
      output += `\n\n**Failures**:\n${JSON.stringify(metadata.failures, null, 2)}`;
    }

    // Add count if present
    if (metadata.count !== undefined) {
      output += `\n\n**count:** ${metadata.count}`;
    }
  }

  output += '\n\n';
  return output;
}

/**
 * Format a single Task object with rich details.
 * When rendered under a project group header, pass showProject: false to
 * avoid repeating the project on every task.
 */
function formatTaskItem(task: Task, index: number, opts: { showProject?: boolean } = {}): string {
  const { showProject = true } = opts;
  const parts: string[] = [];

  // Header with title and ID (nested under a project group header)
  parts.push(`#### ${index + 1}. **${task.title}** (ID: ${task.id})`);

  // Status
  const status = task.done ? '✅ Done' : '❌ Not Done';
  parts.push(`- **Status:** ${status}`);

  // Priority (if set)
  if (task.priority !== undefined && task.priority > 0) {
    const stars = '⭐'.repeat(Math.min(task.priority, 5));
    parts.push(`- **Priority:** ${stars} (${task.priority}/5)`);
  }

  // Due date (if set). Vikunja returns the zero date for "no due date".
  if (task.due_date && !task.due_date.startsWith('0001-01-01')) {
    parts.push(`- **Due:** ${task.due_date}`);
  }

  // Progress (if set)
  if (task.percent_done !== undefined && task.percent_done > 0) {
    parts.push(`- **Progress:** ${task.percent_done}%`);
  }

  // Project — name when resolved, else the bare id. Suppressed inside groups.
  if (showProject && task.project_id) {
    const project = task.project_title
      ? `${task.project_title} (${task.project_id})`
      : `${task.project_id}`;
    parts.push(`- **Project:** ${project}`);
  }

  // Bucket (only when assigned; 0 means "no bucket").
  if (task.bucket_id !== undefined && task.bucket_id !== 0) {
    parts.push(`- **Bucket:** ${task.bucket_id}`);
  }

  // Relative "updated" stale signal (only present when requested via showUpdated).
  if (task.updated_relative) {
    parts.push(`- **Updated:** ${task.updated_relative}`);
  }

  // Labels (if any)
  if (task.labels && task.labels.length > 0) {
    const labelTitles = task.labels.map(l => l.title).join(', ');
    parts.push(`- **Labels:** ${labelTitles}`);
  }

  // Assignees (if any)
  if (task.assignees && task.assignees.length > 0) {
    const assigneeNames = task.assignees.map(a => {
      const email = a.email ? ` (${a.email})` : '';
      return `${a.username}${email}`;
    }).join(', ');
    parts.push(`- **Assignees:** ${assigneeNames}`);
  }

  // Description (if exists). Vikunja stores rich text as HTML; render it as
  // compact plain text so link cruft and markup don't dominate the payload.
  if (task.description) {
    const desc = htmlToPlainText(task.description);
    if (desc) {
      if (desc.includes('\n')) {
        const indented = desc.split('\n').map((l) => `  ${l}`).join('\n');
        parts.push(`- **Description:**\n${indented}`);
      } else {
        parts.push(`- **Description:** ${desc}`);
      }
    }
  }

  return parts.join('\n') + '\n';
}

/**
 * Convert Vikunja's HTML rich text to compact plain text.
 * Unwraps anchors (keeping the URL, and link text only when it differs),
 * turns block/list markup into newlines/bullets, strips remaining tags,
 * decodes common entities, and drops zero-width artifacts.
 */
function htmlToPlainText(html: string): string {
  const entities: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&nbsp;': ' ',
  };

  return html
    // Anchors → "text (url)", or just "url" when text is empty/equal
    .replace(/<a\b[^>]*?href="([^"]*)"[^>]*>(.*?)<\/a>/gi, (_m, href: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, '').trim();
      return !label || label === href ? href : `${label} (${href})`;
    })
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|h[1-6]|ul|ol|li|tr|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;|&lt;|&gt;|&quot;|&#39;|&nbsp;/g, (m) => entities[m] ?? m)
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

/**
 * Heuristic: does this item look like a Task (vs a project/label/plain item)?
 */
function isTaskItem(item: unknown): item is Task {
  if (typeof item !== 'object' || item === null) {
    return false;
  }
  const t = item as Task;
  return (
    Boolean(t.title) &&
    (t.description !== undefined ||
      t.priority !== undefined ||
      t.due_date !== undefined ||
      t.labels !== undefined ||
      t.assignees !== undefined ||
      t.done !== undefined)
  );
}

/**
 * Return the items typed as Task[] when every item is task-like, else null.
 */
function asTaskList(items: DataItem[]): Task[] | null {
  if (items.length === 0) {
    return null;
  }
  return items.every(isTaskItem) ? (items as unknown as Task[]) : null;
}

/** Escape a value for use inside a markdown table cell. */
function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\s*\n+\s*/g, ' / ').trim();
}

function hasRealDueDate(task: Task): boolean {
  return Boolean(task.due_date && !task.due_date.startsWith('0001-01-01'));
}

/**
 * Render a group of tasks as a compact markdown table. Columns are dynamic:
 * only those that at least one task populates are emitted, so a plain list of
 * title-only tasks collapses to `| ID | Task |`. The Column field is the task's
 * kanban bucket; Notes holds the HTML-stripped description, newlines flattened.
 */
function formatTaskTable(tasks: Task[], options?: TaskTableOptions): string {
  const showDone = options?.showDone ?? (new Set(tasks.map((t) => Boolean(t.done))).size > 1);
  const showColumn = tasks.some((t) => Boolean(t.bucket_title));
  const showDue = tasks.some(hasRealDueDate);
  const showPriority = tasks.some((t) => (t.priority ?? 0) > 0);
  const showLabels = tasks.some((t) => Array.isArray(t.labels) && t.labels.length > 0);
  const showUpdated = tasks.some((t) => Boolean(t.updated_relative));
  const showNotes = tasks.some((t) => Boolean(t.description) && Boolean(htmlToPlainText(t.description as string)));

  const columns: string[] = ['ID'];
  if (showDone) columns.push('✓');
  columns.push('Task');
  if (showColumn) columns.push('Column');
  if (showDue) columns.push('Due');
  if (showPriority) columns.push('Pri');
  if (showLabels) columns.push('Labels');
  if (showUpdated) columns.push('Updated');
  if (showNotes) columns.push('Notes');

  const rows = tasks.map((task) => {
    const cells: string[] = [String(task.id ?? '')];
    if (showDone) cells.push(task.done ? '✅' : '');
    cells.push(escapeCell(task.title ?? ''));
    if (showColumn) cells.push(escapeCell(task.bucket_title ?? ''));
    if (showDue) cells.push(hasRealDueDate(task) ? (task.due_date as string).slice(0, 10) : '');
    if (showPriority) cells.push((task.priority ?? 0) > 0 ? String(task.priority) : '');
    if (showLabels) cells.push(task.labels?.map((l) => l.title).join(', ') ?? '');
    if (showUpdated) cells.push(task.updated_relative ?? '');
    if (showNotes) cells.push(task.description ? escapeCell(htmlToPlainText(task.description)) : '');
    return `| ${cells.join(' | ')} |`;
  });

  const header = `| ${columns.join(' | ')} |`;
  const separator = `| ${columns.map(() => '---').join(' | ')} |`;
  return [header, separator, ...rows].join('\n') + '\n';
}

/**
 * Render tasks grouped by project: a header per project (carrying the project
 * name, so it isn't repeated per row) followed by a compact task table.
 */
function formatTasksGroupedByProject(tasks: Task[], options?: TaskTableOptions): string {
  const groups = new Map<number, Task[]>();
  for (const task of tasks) {
    const pid = task.project_id ?? 0;
    const group = groups.get(pid);
    if (group) {
      group.push(task);
    } else {
      groups.set(pid, [task]);
    }
  }

  const sections = Array.from(groups.entries()).map(([pid, group]) => {
    const name = group[0]?.project_title;
    const header = name ? `${name} (ID: ${pid})` : `Project ${pid}`;
    return `### 📁 ${header} — ${group.length} task(s)\n\n${formatTaskTable(group, options)}`;
  });

  return sections.join('\n') + '\n';
}

/**
 * Format a collection with a full item render (up to a safety bound) and a
 * pagination/truncation footer so callers know when more results exist.
 */
function formatCollection(
  collection: DataItem[],
  pagination?: PaginationInfo,
  taskOptions?: TaskTableOptions,
): string {
  let out = `**Results:** ${collection.length} item(s)\n\n`;
  if (collection.length === 0) {
    return out;
  }

  const shown = collection.slice(0, MAX_RENDERED_ITEMS);

  // Task lists render grouped under a project header (one group per project),
  // so the project shows once instead of on every task and cross-project lists
  // read as distinct areas.
  const tasks = asTaskList(shown);
  if (tasks) {
    out += formatTasksGroupedByProject(tasks, taskOptions);
  } else {
    out += formatDataItems(shown);
  }

  if (collection.length > MAX_RENDERED_ITEMS) {
    out +=
      `_Showing first ${MAX_RENDERED_ITEMS} of ${collection.length}. ` +
      `Narrow with a \`filter\` or request a specific \`page\`/\`perPage\`._\n\n`;
  } else if (pagination?.hasMore) {
    out +=
      `_Page ${pagination.page} (${pagination.perPage}/page). More results may exist — ` +
      `pass \`page:${pagination.page + 1}\` or a higher \`perPage\` to see them._\n\n`;
  }

  return out;
}

/**
 * Format array data items
 */
function formatDataItems(items: DataItem[]): string {
  return items.map((item, index) => {
    if (typeof item === 'object' && item !== null) {
      // Check if this is a Task object with rich data
      const task = item as unknown as Task;
      if (task.title && (task.description || task.priority !== undefined ||
          task.due_date || task.labels || task.assignees || task.done !== undefined)) {
        return formatTaskItem(task, index);
      }

      // Fallback to simple formatting for other object types
      const id = item.id || index + 1;
      const title = item.title || item.name || JSON.stringify(item);
      return `${index + 1}. **${title}** (ID: ${id})`;
    }
    return `${index + 1}. ${JSON.stringify(item)}`;
  }).join('\n') + '\n\n';
}

/**
 * Format object data
 */
function formatObjectData(data: Record<string, unknown>): string {
  const entries = Object.entries(data);
  if (entries.length === 0) return '';

  return entries
    .filter(([_, value]) => value !== undefined && value !== null)
    .map(([key, value]) => {
      const formattedValue = typeof value === 'object' && value !== null
        ? JSON.stringify(value, null, 2)
        : String(value);
      return `**${key}:** ${formattedValue}`;
    })
    .join('\n') + '\n\n';
}

/**
 * Format response as MCP content array
 * Direct replacement for AORP formatting
 */
export function formatMcpResponse(response: SimpleResponse): Array<{ type: 'text'; text: string }> {
  return [{
    type: 'text' as const,
    text: response.content,
  }];
}

// Note: ResponseData and DataItem are exported from types/index.ts
