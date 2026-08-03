import * as z from 'zod';

export type GetMinorHashMatchesInput = z.infer<typeof getMinorHashMatchesSchema>;
// The whole queue is returned in one page so the client can sort and filter across
// every column. Deliberately not paginated: rows leave this queue as they're
// actioned, and any server-side window (OFFSET or keyset) would either skip
// unreviewed models or restrict sorting to the loaded subset. The candidate CTE —
// not the row count — dominates the cost, so one full fetch beats paging through it.
export const getMinorHashMatchesSchema = z.object({
  limit: z.number().min(1).max(2000).default(1000),
});

export type GetAutoFlaggedMinorModelsInput = z.infer<typeof getAutoFlaggedMinorModelsSchema>;
export const getAutoFlaggedMinorModelsSchema = z.object({
  limit: z.number().min(1).max(2000).default(1000),
});

export type GetMinorHashMatchDetailInput = z.infer<typeof getMinorHashMatchDetailSchema>;
export const getMinorHashMatchDetailSchema = z.object({
  modelId: z.number(),
  minorModelId: z.number(),
});

// No minorModelId: an auto-flagged row has no stored pointer to its match, so the
// seed is resolved server-side from the model's own hashes.
export type GetAutoFlaggedMinorDetailInput = z.infer<typeof getAutoFlaggedMinorDetailSchema>;
export const getAutoFlaggedMinorDetailSchema = z.object({
  modelId: z.number(),
});
