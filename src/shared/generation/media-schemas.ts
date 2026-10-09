/**
 * Media Value Schemas
 *
 * Zod schemas for image and video values used across generation graphs.
 *
 * 🔴 A LEAF MODULE ON PURPOSE. These are `const` declarations, so any import edge back
 * into a graph file puts them in a cycle where a graph reads them during the temporal
 * dead zone and gets `undefined`. Keeping this module import-free is what guarantees
 * they are initialised before any graph file runs.
 */

import z from 'zod';

/** Zod schema for image value (url + dimensions) */
export const imageValueSchema = z.object({
  url: z.string(),
  width: z.number(),
  height: z.number(),
});

/** Zod schema for video metadata */
export const videoMetadataSchema = z.object({
  fps: z.number(),
  width: z.number(),
  height: z.number(),
  duration: z.number(),
});

/** Zod schema for video value */
export const videoValueSchema = z.object({
  url: z.string(),
  metadata: videoMetadataSchema.optional(),
});
