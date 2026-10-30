import type { ScanLabelCard } from '$lib/server/scan-label.service';
import { z } from 'zod';

export const VOTES_PER_ITEM = 3;
/** Block votes that make a block the majority; voting still runs to `VOTES_PER_ITEM`. */
export const BLOCK_MAJORITY = 2;
export const LEASE_MS = 2 * 60_000;
/** Relative share of claims served from each source; an empty source passes its turn on. */
export const QUEUE_MIX = { upload: 45, prompt: 45, control: 10 } as const;
export type QueueSource = keyof typeof QUEUE_MIX;
/** Mirrors the `ScanLabelQuota."dailyVotes"` default and floor in the migration. */
export const DEFAULT_DAILY_QUOTA = 50;

/**
 * Why a moderator voted Block. Every reason is offered on every item, whatever the scan flagged.
 * 🔴 The ids are STORED values, mirrored by the CHECK on `ScanLabelVote.reason`: change both together.
 */
export const BLOCK_REASONS = [
  {
    id: 'minor-sexual',
    label: 'Minor / sexual or suggestive',
    help: 'A character depicted as under 18 in nudity, sexual activity, or sexualized clothing/poses, in any rendering style.',
  },
  {
    id: 'minor-photoreal',
    label: 'Photorealistic minor',
    help: 'A photorealistic depiction of someone under 18, including otherwise nonsexual scenes.',
  },
  {
    id: 'minor-violence',
    label: 'Minor / violence or abuse',
    help: 'Abuse, exploitation, endangerment, or violence involving a minor; exclude ordinary play, sports, and minor accidental injuries.',
  },
  {
    id: 'real-person',
    label: 'Real person',
    help: 'A recognizable likeness of an actual person, in any context. A realistic-looking fictional person does not qualify just because the rendering is photorealistic.',
  },
  {
    id: 'bestiality',
    label: 'Bestiality',
    help: 'Sexual activity involving animals or feral creatures; animal ears or a tail alone do not establish this.',
  },
  {
    id: 'non-consent',
    label: 'Sexual violence / non-consent',
    help: 'Sexual activity involving force, coercion, or someone unable to consent, such as an unconscious person. Restraints alone do not establish non-consent.',
  },
  {
    id: 'graphic-violence',
    label: 'Graphic violence / abuse',
    help: 'Human death, torture, mutilation, graphic injuries, or domestic/animal abuse covered by the content rules, not simply anything that looks realistic.',
  },
  {
    id: 'other',
    label: 'Other ToS violation',
    help: 'Another specific violation (e.g. prohibited bodily waste, incest, hate/extremism, self-harm). Requires a short comment.',
  },
] as const;

export type BlockReason = (typeof BLOCK_REASONS)[number]['id'];
export const BLOCK_REASON_IDS = BLOCK_REASONS.map((r) => r.id) as [BlockReason, ...BlockReason[]];
/** The one reason that needs a comment. */
export const REASON_NEEDING_COMMENT: BlockReason = 'other';
export const REASON_COMMENT_MAX = 500;

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

/** Where a card's media is served: keyed by the claim token, like the vote. */
export const cardMediaPath = (token: string) => `/images/scan-labels/media/${token}`;

/** The card as the page gets it: the claim token stands in for every internal id and media key. */
export function pageCard({ token, type, width, height, leaseExpiresAt }: ScanLabelCard) {
  return { token, type, width, height, leaseExpiresAt, mediaSrc: cardMediaPath(token) };
}
