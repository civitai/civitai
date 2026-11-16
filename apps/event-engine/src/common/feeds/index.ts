/**
 * Barrel export for all feed modules
 * Import with: import * as feeds from '../common/feeds'
 */

export { ImagesFeed } from './images.feed';
// The simple example has been replaced with the full implementation

// Add other feeds as needed (ModelFeed, PostFeed, etc.)

// Export types
export type {
  FeedContext,
  FeedQueryInput,
  FeedResult,
  FeedAdvancedOptions,
  UpsertType,
  SchemaFieldType,
  FeedSchema,
  InferSchemaType,
  CreateFeedConfig,
} from './types';
