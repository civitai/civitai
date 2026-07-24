/**
 * Meilisearch interface types
 *
 * These interfaces define the minimal Meilisearch API surface needed for the feed system,
 * allowing us to avoid a direct dependency on the meilisearch package in the common module.
 *
 * The actual MeiliSearch client from the library naturally satisfies these interfaces.
 * Usage: const client: IMeilisearch = new MeiliSearch({ host, apiKey })
 */

/**
 * Task status values from Meilisearch
 */
export type MeilisearchTaskStatus =
  | 'enqueued'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'canceled';

/**
 * Enqueued task returned by methods that queue operations
 * This matches the EnqueuedTask type from meilisearch library
 * Note: Timestamps are Date objects in the actual library
 */
export type MeilisearchTask = {
  taskUid: number;
  indexUid?: string | null;
  status: MeilisearchTaskStatus;
  type?: string;
  enqueuedAt: Date | string; // Library uses Date, some serialized versions use string
};

/**
 * Full task details (returned when waiting for a task to complete)
 * Note: The library returns 'uid' for completed tasks, 'taskUid' for enqueued tasks
 */
export type MeilisearchFullTask = {
  uid: number; // Full task uses uid, not taskUid
  taskUid?: number; // Optional for compatibility
  indexUid?: string | null;
  status: MeilisearchTaskStatus;
  type?: string;
  enqueuedAt: Date | string;
  batchUid?: number | null;
  canceledBy?: number | null;
  details?: Record<string, unknown>;
  error?: unknown;
  duration?: string | null;
  startedAt?: Date | string | null;
  finishedAt?: Date | string | null;
};

/**
 * Granular filterable attribute configuration
 * Matches the Meilisearch library's GranularFilterableAttribute type
 */
export type GranularFilterableAttribute = {
  attributePatterns: string[];
  features: {
    facetSearch: boolean;
    filter: {
      equality: boolean;
      comparison: boolean;
    };
  };
};

/**
 * Filterable attributes can be either strings or granular configurations
 * Matches the Meilisearch library's FilterableAttributes type
 */
export type FilterableAttributes = (string | GranularFilterableAttribute)[] | null;

/**
 * Meilisearch settings type
 * Note: Using flexible types to match the actual Meilisearch library types
 */
export type MeilisearchSettings = {
  filterableAttributes?: FilterableAttributes;
  sortableAttributes?: string[] | null;
  searchableAttributes?: string[] | null;
  displayedAttributes?: string[] | null;
  rankingRules?: string[] | null;
  stopWords?: string[] | null;
  synonyms?: Record<string, string[]> | null;
  distinctAttribute?: string | null;
  [key: string]: unknown; // Allow additional properties
};

export type MeilisearchSearchOptions = {
  filter?: string;
  sort?: string[];
  limit?: number;
  offset?: number;
  attributesToRetrieve?: string[];
  attributesToHighlight?: string[];
  attributesToCrop?: string[];
};

/**
 * Hit type returned in search results
 * The actual library adds metadata fields to documents
 * Matches the Hit type from meilisearch library
 * Using any as default to match library's RecordAny
 */
export type MeilisearchHit<T = any> = T & {
  _formatted?: Partial<T>;
  _matchesPosition?: unknown;
  _rankingScore?: number;
  _rankingScoreDetails?: unknown;
  _geo?: unknown;
  _federation?: unknown;
  [key: string]: unknown; // Allow additional metadata fields
};

/**
 * Search result type
 * Compatible with SearchResponse from meilisearch library
 * Includes both finite pagination (page-based) and infinite pagination (offset-based) fields
 * Using any as default to match library's RecordAny
 */
export type MeilisearchSearchResult<T = any> = {
  hits: MeilisearchHit<T>[];
  processingTimeMs: number;
  query: string;
  // Infinite pagination fields
  estimatedTotalHits?: number;
  offset?: number;
  limit?: number;
  // Finite pagination fields
  totalHits?: number;
  hitsPerPage?: number;
  page?: number;
  totalPages?: number;
  // Additional optional fields
  facetDistribution?: Record<string, Record<string, number>>;
  facetStats?: Record<string, { min: number; max: number }>;
  facetsByIndex?: Record<string, unknown>;
  [key: string]: unknown; // Allow additional properties
};

export interface IMeilisearchIndex {
  /**
   * Update index settings
   */
  update(options: { primaryKey: string }): Promise<MeilisearchTask>;

  /**
   * Get current index settings
   */
  getSettings(): Promise<MeilisearchSettings>;

  /**
   * Update searchable attributes
   */
  updateSearchableAttributes(attributes: string[]): Promise<MeilisearchTask>;

  /**
   * Update sortable attributes
   */
  updateSortableAttributes(attributes: string[]): Promise<MeilisearchTask>;

  /**
   * Update filterable attributes
   */
  updateFilterableAttributes(attributes: string[]): Promise<MeilisearchTask>;

  /**
   * Update ranking rules
   */
  updateRankingRules(rules: string[]): Promise<MeilisearchTask>;

  /**
   * Update documents in the index
   */
  updateDocuments(
    documents: Array<Record<string, unknown>>,
    options?: { primaryKey?: string }
  ): Promise<MeilisearchTask>;

  /**
   * Delete documents by IDs
   */
  deleteDocuments(ids: number[] | string[]): Promise<MeilisearchTask>;

  /**
   * Search documents
   * Returns search results with hits matching the document type
   * Using any for compatibility with library's complex SearchResponse type
   */
  search<T = any>(
    query: string | null,
    options?: any
  ): Promise<any>;
}

export interface IMeilisearch {
  /**
   * Get an existing index
   */
  getIndex(indexName: string): Promise<IMeilisearchIndex>;

  /**
   * Create a new index
   */
  createIndex(indexName: string, options?: { primaryKey?: string }): Promise<MeilisearchTask>;

  /**
   * Task client for waiting on tasks
   */
  tasks: {
    waitForTask(
      taskUid: number | MeilisearchTask,
      options?: { timeout?: number; interval?: number }
    ): Promise<MeilisearchFullTask>;
  };
}
