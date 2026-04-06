/**
 * Media Value Schemas
 *
 * Zod schemas for image and video values used across generation graphs.
 * Extracted from common.ts to avoid circular dependency TDZ errors:
 * common.ts → config/workflows.ts → kling-graph.ts → common.ts
 *
 * These are `const` declarations that hit the temporal dead zone when
 * accessed during the circular import chain. Putting them in a leaf
 * module ensures they're fully initialized before any graph file runs.
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
