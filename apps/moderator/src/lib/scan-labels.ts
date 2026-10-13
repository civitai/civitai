import { z } from 'zod';

export const VOTES_PER_ITEM = 3;
/** Block votes at which the image is blocked; voting still runs to `VOTES_PER_ITEM`. */
export const BLOCK_MAJORITY = 2;
export const LEASE_MS = 2 * 60_000;
/** Mirrors the `ScanLabelQuota."dailyVotes"` default and floor in the migration. */
export const DEFAULT_DAILY_QUOTA = 50;

export const scanLabelFiltersSchema = z.object({
  day: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)))
    .optional()
    .catch(undefined),
  version: z.string().trim().min(1).max(200).optional().catch(undefined),
});

export type ScanLabelFilters = { day?: string; flaggerVersion?: string };

export const toFilters = (q: z.infer<typeof scanLabelFiltersSchema>): ScanLabelFilters => ({
  day: q.day,
  flaggerVersion: q.version,
});
