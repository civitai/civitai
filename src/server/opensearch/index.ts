export {
  openSearchClient,
  bulkOperation,
  bulkIndexDocs,
  bulkUpdateDocs,
  deleteDocsById,
  deleteDocsByQuery,
} from './client';
export { syncToOpenSearch, syncDeleteByQuery } from './sync';
export { ensureIndex, swapIndex, deleteDocuments } from './util';
export {
  OPENSEARCH_METRICS_IMAGES_INDEX,
  metricsImagesMappings,
  metricsImagesSettings,
} from './metrics-images.mappings';
export * from './query-builder';
