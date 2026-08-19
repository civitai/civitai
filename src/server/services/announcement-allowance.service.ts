import { z } from 'zod';
import { dbRead } from '~/server/db/client';
import { getCreatorRequirements } from '~/server/services/creator-program.service';

export const ANNOUNCEMENTS_CONFIG_KEY = 'announcements:config';

export const ANNOUNCEMENT_TIERS = ['free', 'bronze', 'silver', 'gold'] as const;
export type AnnouncementTier = (typeof ANNOUNCEMENT_TIERS)[number];

/**
 * Eligibility floor and per-tier caps, both operator-tunable in `KeyValue` so the
 * anti-spam posture can move without a deploy — the same posture as
 * `placement:config`. A malformed or missing row falls back to these defaults
 * rather than throwing: announcements failing closed on a bad config edit would
 * take the feature out entirely, and every value is clamped anyway.
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

const announcementsConfigSchema = z
  .object({
    minScore: z.number().int().min(0),
    caps: z.object({
      free: capSchema.optional(),
      bronze: capSchema.optional(),
      silver: capSchema.optional(),
      gold: capSchema.optional(),
    }),
  })
  .partial();

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

async function getConfig() {
  try {
    const row = await dbRead.keyValue.findUnique({ where: { key: ANNOUNCEMENTS_CONFIG_KEY } });
    const parsed = announcementsConfigSchema.safeParse(row?.value ?? {});
    if (parsed.success) {
      return {
        minScore: parsed.data.minScore ?? DEFAULTS.minScore,
        caps: { ...DEFAULTS.caps, ...parsed.data.caps },
      };
    }
  } catch {
    // Fall through to defaults.
  }

  return { minScore: DEFAULTS.minScore, caps: { ...DEFAULTS.caps } };
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
  const [config, requirements] = await Promise.all([getConfig(), getCreatorRequirements(userId)]);

  const tier = toAnnouncementTier(requirements?.membership);
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

export async function assertCanPostAnnouncement(userId: number) {
  const allowance = await getAnnouncementAllowance(userId);
  return { allowed: allowance.eligible && allowance.used < allowance.limit, allowance };
}
