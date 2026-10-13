import { z } from 'zod';

export const VOTES_PER_ITEM = 3;
/** Block votes that make a block the majority; voting still runs to `VOTES_PER_ITEM`. */
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

export const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` of a UTC instant. */
export const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export const utcDayStart = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/** `[start, end)` of a `YYYY-MM-DD` UTC day. */
export const dayBounds = (day: string) => {
  const start = new Date(`${day}T00:00:00.000Z`);
  return { start, end: new Date(start.getTime() + DAY_MS) };
};

/** The `days` UTC days ending on `lastDay`, oldest first. */
export const dayRange = (lastDay: string, days: number): string[] => {
  const last = dayBounds(lastDay).start.getTime();
  return Array.from({ length: days }, (_, i) => isoDay(new Date(last - (days - 1 - i) * DAY_MS)));
};

export const effectiveQuota = (row: { dailyVotes: number } | undefined) =>
  row?.dailyVotes ?? DEFAULT_DAILY_QUOTA;

/** Zero votes is a day off, not a miss: there is no leave bookkeeping. A day still in progress is
 *  never a miss. Judged against the CURRENT quota and roster, not the ones in force that day. */
export type QuotaStatus = 'met' | 'missed' | 'off' | 'in-progress' | 'unlisted';

export function quotaStatus(
  votes: number,
  quota: number,
  onRoster: boolean,
  complete: boolean
): QuotaStatus {
  if (!onRoster) return 'unlisted';
  if (votes >= quota) return 'met';
  if (!complete) return 'in-progress';
  return votes === 0 ? 'off' : 'missed';
}

export type QuotaRow = {
  userId: number;
  username: string | null;
  quota: number;
  onRoster: boolean;
  days: { day: string; votes: number; status: QuotaStatus }[];
};
