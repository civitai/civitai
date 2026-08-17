import { logger } from '@/utils/logger';
import { createEventHandler } from './base'
import { WorkflowMessage, createWorkflowSample } from '@/types/events'

/**
## Metrics driven by jobs (ClickHouse):
- ModelMetric.generationCount (job completion)
- ModelVersionMetric.generationCount (job completion)
*/

// Based on the image-scan.ts handler configuration:
// - Step 0: wdTagging (output: false) - not included in outputs
// - Step 1: rating (output: true) - outputs[0]
// - Step 2: hash (output: true) - outputs[1]
type ImageScannedMessage = WorkflowMessage<[
  { tags: Record<string, number> },
  { nsfwLevel: string; isBlocked: boolean; blockedReason?: string },
  { hashes: { perceptual: string } }
]>

export const imageScannedHandler = createEventHandler<ImageScannedMessage>({
  topics: ['orchestrator.imageScanned'],
  // The three disables here are all the same reason: this handler is not in the registry in
  // `handlers/index.ts` and nothing publishes `orchestrator.imageScanned` (its only producer is
  // the commented-out body of `outbox/image-scan.ts`), so none of this runs yet. The bindings
  // are what the TODOs below will use.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  processor: async ({ record, pg, actions }) => {
    // TODO briant: Implement image scanned processing logic
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { workflowId, status, metadata, outputs } = record;

    // Extract imageId from metadata
    const { imageId } = metadata ?? {};
    if (!imageId) {
      logger.warn(`[imageScannedHandler] Missing imageId in metadata for workflow ${workflowId}`);
      return;
    };

    // TODO: handle workflow status (e.g., only process if status is 'completed', appropriate handlding for 'failed', etc.)

    // Extract outputs from the workflow
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const [{tags}, {nsfwLevel, isBlocked}, { hashes }] = outputs;

    // TODO: handle scanned image results
    // TODO: add an `execute` method to pg that takes a query and params and returns nothing - skips caching.
  },
  debug: (faker) => ({
    sample: () => createWorkflowSample(
      faker,
      () => [
        {
          tags: Object.fromEntries(
            faker.helpers.arrayElements(['portrait', 'landscape', 'abstract', 'digital art', 'photo'], { min: 1, max: 3 })
              .map(tag => [tag, Math.round(faker.number.float({ min: 0.5, max: 1.0 }) * 100) / 100])
          ),
        },
        {
          nsfwLevel: faker.helpers.arrayElement(['PG', 'PG13', 'R', 'X', 'XXX']),
          isBlocked: faker.number.int({ min: 0, max: 9 }) === 0,
          blockedReason: faker.helpers.maybe(() => faker.helpers.arrayElement(['csam', 'minor', 'spam']), { probability: 0.1 }),
        },
        {
          hashes: {
            perceptual: faker.string.alphanumeric(16)
          }
        }
      ],
      // Metadata
      {
        imageId: faker.number.int({ min: 1, max: 100000 })
      }
    )
  })
})
