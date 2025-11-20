import type { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import type { JobContext } from '~/server/jobs/job';

/**
 * Interface for search index update operations
 * This interface is used to break circular dependencies between
 * search indices and services
 */
export interface SearchIndexQueueUpdate {
  queueUpdate(items: Array<{ id: number; action?: SearchIndexUpdateQueueAction }>): Promise<void>;
}

export interface SearchIndexSync {
  updateSync(
    items: Array<{ id: number; action?: SearchIndexUpdateQueueAction }>,
    jobContext?: JobContext
  ): Promise<void>;
}

export interface SearchIndexData {
  getData(ids: number[]): Promise<any>;
}

/**
 * Full search index interface with all operations
 */
export interface SearchIndex extends SearchIndexQueueUpdate, SearchIndexSync, SearchIndexData {
  indexName: string;
}
