/**
 * Type definitions for the filtering strategy pattern
 */

import type { Task, GetTasksParams } from 'node-vikunja';
import type { FilterExpression } from '../../filters';

/**
 * Arguments for filtering operations
 */
export interface FilteringArgs {
  projectId?: number;
  page?: number;
  perPage?: number;
  search?: string;
  sort?: string;
  filter?: string;
  filterId?: string;
  allProjects?: boolean;
  done?: boolean;
  bucketId?: number;
  bucket_id?: number;
  viewId?: number;
  view_id?: number;
}

/**
 * Parameters passed to filtering strategies
 */
export interface FilteringParams {
  args: FilteringArgs;
  filterExpression: FilterExpression | null;
  filterString: string | undefined;
  params: GetTasksParams;
  /**
   * When true, load the complete result set by paging through the API rather
   * than a single page. Required for correct client-side narrowing, since the
   * Vikunja server caps per_page (default 50) and one request is not the whole set.
   */
  loadAll?: boolean;
}

/**
 * Metadata about the filtering operation performed
 */
export interface FilteringMetadata {
  serverSideFilteringUsed: boolean;
  serverSideFilteringAttempted: boolean;
  clientSideFiltering: boolean;
  filteringNote: string;
}

/**
 * Result of a filtering operation
 */
export interface FilteringResult {
  tasks: Task[];
  metadata: FilteringMetadata;
}

/**
 * Configuration for strategy selection
 */
export interface StrategyConfig {
  enableServerSide: boolean;
}

/**
 * Task filtering strategy interface
 */
export interface TaskFilteringStrategy {
  /**
   * Execute the filtering strategy
   * @param params - Filtering parameters
   * @returns Promise resolving to filtering result
   */
  execute(params: FilteringParams): Promise<FilteringResult>;
}
