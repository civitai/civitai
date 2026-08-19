import { z } from 'zod';
import { dbRead } from '~/server/db/client';
import { getCreatorRequirements } from '~/server/services/creator-program.service';
import { getCapTier } from '~/server/services/subscriptions.service';

export const ANNOUNCEMENTS_CONFIG_KEY = 'announcements:config';

export const ANNOUNCEMENT_TIERS = ['free', 'bronze', 'silver', 'gold'] as const;
export type AnnouncementTier = (typeof ANNOUNCEMENT_TIERS)[number];

/**
 * Eligibility floor and per-tier caps, both operator-tunable in `KeyValue` so the
 * anti-spam posture can move without a deploy — the same posture as
 * `placement:config`. A malformed or missing row falls back to these defaults
 * rather than throwing: announcements failing closed on a bad config edit would
 * take the feature out entirely, and every value is range-checked before it is used.
 *
 * 🔴 Read this, never restate the defaults. A surface that quotes a compiled
 * number while the row says something else tells the creator a limit they do not
 * have.
 */
const DEFAULTS = {
  minScore: 10_000,
  caps: {
    free: { days: 30, count: 1 },
    bronze: { days: 14, count: 1 },
    silver: { days: 7, count: 1 },
    gold: { days: 7, count: 2 },
  },
} as const;

const capSchema = z.object({
  days: z.number().int().min(1).max(365),
  count: z.number().int().min(0).max(100),
});

const minScoreSchema = z.number().int().min(0);

export type AnnouncementAllowance = {
  /** Creator score clears the floor. False means no slots at any tier. */
  eligible: boolean;
  tier: AnnouncementTier;
  score: number;
  minScore: number;
  used: number;
  limit: number;
  windowDays: number;
  /** When the oldest announcement in the window ages out. Null when a slot is free. */
  nextAvailableAt: Date | null;
};

/**
 * Each field is parsed on its own, and a bad one falls back alone. A single safeParse over
 * the whole row discards every value when any one of them is malformed — so one mistyped
 * cap would also throw away a good minScore sitting beside it, silently, in the direction
 * of the compiled default.
 */
async function getConfig() {
  let value: Record<string, unknown> = {};
  try {
    const row = await dbRead.keyValue.findUnique({ where: { key: ANNOUNCEMENTS_CONFIG_KEY } });
    if (row?.value && typeof row.value === 'object') value = row.value as Record<string, unknown>;
  } catch {
    // Fall through to defaults.
  }

  const minScore = minScoreSchema.safeParse(value.minScore);
  const storedCaps = (value.caps ?? {}) as Record<string, unknown>;

  const caps: Record<AnnouncementTier, { days: number; count: number }> = { ...DEFAULTS.caps };
  for (const tier of ANNOUNCEMENT_TIERS) {
    const parsed = capSchema.safeParse(storedCaps[tier]);
    if (parsed.success) caps[tier] = parsed.data;
  }

  return { minScore: minScore.success ? minScore.data : DEFAULTS.minScore, caps };
}

function toAnnouncementTier(membership: string | null | undefined): AnnouncementTier {
  const tier = (membership ?? 'free').toLowerCase();
  return (ANNOUNCEMENT_TIERS as readonly string[]).includes(tier)
    ? (tier as AnnouncementTier)
    : 'free';
}

/**
 * What this creator may post right now, and when that changes.
 *
 * Read-only and cheap enough to call for rendering — the sale composer on
 * `868ktk1ku` calls it to decide whether to offer announcing at all. The three
 * states it distinguishes are not interchangeable: below the score floor is not
 * the same as out of slots this month, and a surface that shows "try again later"
 * to someone who will never be eligible is lying to them.
 */
export async function getAnnouncementAllowance(userId: number): Promise<AnnouncementAllowance> {
  // Tier through getCapTier, not through getCreatorRequirements: the latter accepts
  // `incomplete` subscriptions, so a lapsed payment kept its paid caps. getCapTier is the
  // helper every other monetization cap resolves through.
  const [config, requirements, capTier] = await Promise.all([
    getConfig(),
    getCreatorRequirements(userId),
    getCapTier(userId),
  ]);

  const tier = toAnnouncementTier(capTier);
  const cap = config.caps[tier] ?? DEFAULTS.caps[tier];
  // Two coercions, both load-bearing. getCreatorRequirements returns score as
  // { min, current }, so Number() on the object itself is NaN and NaN >= minScore is
  // false — that silently refused every creator forever. And `current` arrives from a
  // raw ::numeric as a Decimal, which serialises to a quoted string over JSON: the
  // comparison below survives it, arithmetic downstream would not.
  const score = Number(requirements?.score?.current ?? 0) || 0;
  const eligible = score >= config.minScore;

  const windowStart = new Date(Date.now() - cap.days * 24 * 60 * 60 * 1000);
  // Spends, not live announcements: counting the rows themselves would return the slot
  // when one is deleted, which makes the cap refundable and therefore not a cap.
  const recent = await dbRead.announcementSpend.findMany({
    where: { userId, createdAt: { gte: windowStart } },
    select: { createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  const used = recent.length;
  const oldest = recent[0]?.createdAt;

  return {
    eligible,
    tier,
    score,
    minScore: config.minScore,
    used,
    limit: cap.count,
    windowDays: cap.days,
    nextAvailableAt:
      used < cap.count || !oldest
        ? null
        : new Date(oldest.getTime() + cap.days * 24 * 60 * 60 * 1000),
  };
}
