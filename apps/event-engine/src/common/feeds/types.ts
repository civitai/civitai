import { EntityType, EntityMetricMap } from '../types/metric-types';
import * as caches from '../caches';
import { IMeilisearchIndex } from '../types/meilisearch-interface';


/**
 * Context provided to feed functions
 * Contains database clients, cache, metrics, search index, and pagination
 */
export type FeedContext<E extends EntityType> = {
  pg: {
    query: <T = any>(query: string, params?: any[]) => Promise<T[]>;
  };
  ch: {
    query: <T = any>(query: string, params?: any[]) => Promise<T[]>;
  };
  cache: {
    fetch: <K extends keyof typeof caches>(
      name: K,
      ids: number[]
    ) => Promise<Awaited<ReturnType<(typeof caches)[K]['fetch']>>>;
    // Direct Redis operations for feed-specific caching
    mGet: <T>(keys: string[]) => Promise<(T | null)[]>;
    set: <T>(key: string, value: T, options?: { EX?: number }) => Promise<void>;
    sAdd: <T>(key: string, values: T[]) => Promise<void>;
  };
  metric: {
    fetch: (ids: number[]) => Promise<Record<number, EntityMetricMap[E]>>;
  };
  index: IMeilisearchIndex;
  pagination: {
    limit: number;
    cursor?: string;
    offset?: number; // For offset-based pagination
  };
};

/**
 * Input for feed queries
 * Includes pagination (limit, cursor) plus custom filter fields
 */
export type FeedQueryInput<T extends Record<string, any>> = {
  limit?: number;
  cursor?: string; // '{sortAt}:{id}' - Flexible for multipart cursors
} & T;

/**
 * Result from feed queries
 * Contains data and cursor for pagination
 */
export type FeedResult<T> = {
  items: T[];
  nextCursor?: string;
};

/**
 * Advanced configuration options for feeds
 */
export type FeedAdvancedOptions = {
  fetchBatchSize: number; // default 1000 - batch size for createDocuments
  upsertBatchSize: number; // default 100k - batch size for Meilisearch updates
  createConcurrency: number; // default 2 - concurrent createDocuments calls
};

/**
 * Type of document update
 * - 'full': Complete document with all data
 * - 'metrics': Only update metric fields (lightweight)
 */
export type UpsertType = 'full' | 'metrics';

/**
 * Schema field type definition
 * Unified type for all field types with optional properties
 */
export type SchemaFieldType = {
  type: 'string' | 'number' | 'Date' | 'boolean' | 'array';
  arrayType?: 'string' | 'number' | 'boolean'; // Only used when type is 'array'
  sortable?: boolean;
  filterable?: boolean;
  primary?: boolean;
};

/**
 * Feed schema definition
 * Maps field names to their types and properties
 */
export type FeedSchema = Record<string, SchemaFieldType>;

/**
 * Infer TypeScript type from schema definition
 * Converts schema field types to actual TypeScript types
 */
export type InferSchemaType<S extends FeedSchema> = {
  [K in keyof S]: S[K]['type'] extends 'string'
    ? string
    : S[K]['type'] extends 'number'
    ? number
    : S[K]['type'] extends 'Date'
    ? Date
    : S[K]['type'] extends 'boolean'
    ? boolean
    : S[K]['type'] extends 'array'
    ? S[K] extends { arrayType: infer AT }
      ? AT extends 'string'
        ? string[]
        : AT extends 'number'
        ? number[]
        : AT extends 'boolean'
        ? boolean[]
        : never
      : never
    : never;
};

/**
 * Configuration for creating a feed
 * Includes all the necessary functions and settings
 */
export type CreateFeedConfig<
  E extends EntityType,
  TInput extends Record<string, any>,
  TSchema extends FeedSchema,
  TDocument = InferSchemaType<TSchema>,
  TPopulated = any
> = {
  entityType: E;
  name: string;
  connection?: {
    host?: string;
    apiKey?: string;
  };
  schema: TSchema;
  createDocuments: (
    ctx: FeedContext<E>,
    ids: number[],
    type?: UpsertType
  ) => Promise<TDocument[]>;
  queryDocuments: (ctx: FeedContext<E>, input: TInput) => Promise<TDocument[]>;
  // This is the key - TDocument flows from above methods to here
  // populateDocuments receives input for post-filtering and conditional data fetching
  populateDocuments: (
    ctx: FeedContext<E>,
    documents: TDocument[],
    input: TInput
  ) => Promise<TPopulated[]>;
  /**
   * Optional function to extract cursor from a document
   * If not provided, uses default format: sortAt:id or just id
   */
  getCursor?: (doc: TDocument) => string;
  options?: Partial<FeedAdvancedOptions>;
};
