import * as z from 'zod';

// The `blocks.prepareTrainingDataset` input items (App Blocks `kind:'training'`).
//
// Kept apart from `workflow.schema.ts`, which re-exports it, and FREE OF IMPORTS
// other than zod: the page host validates a block's `PREPARE_TRAINING_DATASET`
// payload with this exact schema (`prepareTrainingDatasetGate.ts`), and importing
// `workflow.schema.ts` there would put its step and recipe registries in the page
// host's client bundle.

/** Max images in one prepared training dataset (`blocks.prepareTrainingDataset`). */
export const BLOCK_TRAINING_DATASET_MAX_ITEMS = 50;
/** Max characters of one training caption. */
export const BLOCK_TRAINING_CAPTION_MAX_CHARS = 1000;

/** `blocks.prepareTrainingDataset` items: the viewer's image ids and their captions. */
export const blockTrainingDatasetItemsSchema = z
  .array(
    z
      .object({
        imageId: z.number().int().positive(),
        caption: z.string().max(BLOCK_TRAINING_CAPTION_MAX_CHARS),
      })
      .strict()
  )
  .min(1)
  .max(BLOCK_TRAINING_DATASET_MAX_ITEMS);
