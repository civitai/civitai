import * as z from 'zod';
import { toStringList } from '~/utils/array-helpers';
import { isBetweenToday } from '~/utils/date-helpers';
import { numberWithCommas } from '~/utils/number-helpers';
import { creatorScoreFromMeta } from '~/shared/utils/creator-score';
import type { RateLimitKind } from '~/shared/utils/rate-limit-meta';

/**
 * Every tunable usage limit, keyed by the id clients see on a 429 and on `/api/v1/me/limits`.
 * The numbers here are the code defaults; the KeyValue row `usage-limits` overrides them per
 * entry (see `usageLimitOverridesSchema`), and a bad or missing override serves these.
 */

export type UsageLimitWindow =
  /** A sliding window counted in the caller's rate-limit bucket. */
  | { type: 'rolling'; seconds: number }
  /** Calendar windows in UTC. Not countable in a rate-limit bucket: the limit's owner counts them. */
  | { type: 'utc-day' }
  | { type: 'utc-month' }
  /** A standing allowance with no window (storage held): it frees up only when usage drops. */
  | { type: 'standing' };

export const usageLimitTiers = ['free', 'founder', 'bronze', 'silver', 'gold'] as const;
export type UsageLimitTier = (typeof usageLimitTiers)[number];
/** `member` applies to these tiers when they have no entry of their own. Founder is not one. */
const MEMBER_TIERS: readonly UsageLimitTier[] = ['bronze', 'silver', 'gold'];

/** `limit` replaces the score-tier limit; `multiplier` scales it. */
export type UsageLimitTierRule = { limit: number } | { multiplier: number };

/** The part of an entry the KeyValue row may override. */
export type UsageLimitValues = {
  /** The limit at Creator Score 0 with no tier rule. */
  base: number;
  /** The highest-limit entry the caller's Creator Score meets raises the base. */
  byScore?: { minScore: number; limit: number }[];
  /** Read by the caller's tier, falling back to `member` for bronze, silver and gold. */
  byTier?: Partial<Record<UsageLimitTier | 'member', UsageLimitTierRule>>;
  /** Not enforced and not listed. */
  disabled?: boolean;
};

export type UsageLimitResolution = {
  limit: number;
  /** The `minScore` of the score tier the caller reached; 0 for the base. */
  minScore: number;
  /** Whether a tier rule changed the limit. */
  tierRule: UsageLimitTierRule | undefined;
  values: UsageLimitValues;
};

export type UsageLimitDef = UsageLimitValues & {
  id: string;
  area: string;
  kind: RateLimitKind;
  label: string;
  window: UsageLimitWindow;
  /** Code-only: the limit applies only to accounts on the calendar day they signed up. */
  appliesTo?: 'first-day';
  /** A gate (a limit-0 block) that overrides may not change. */
  configurable?: false;
  message?: string | ((resolution: UsageLimitResolution) => string | undefined);
};

const HOUR = 60 * 60;
const DAY = 24 * HOUR;
const rolling = (seconds: number): UsageLimitWindow => ({ type: 'rolling', seconds });

const multiplierWords: Record<number, string> = { 2: 'double', 3: 'triple' };

/** What the daily post refusal says: the caller's limit, and only the rises still ahead. */
function dailyPostLimitMessage({ limit, minScore, tierRule, values }: UsageLimitResolution) {
  const higher = (values.byScore ?? [])
    .filter((tier) => tier.minScore > minScore)
    .map((tier) => tier.minScore)
    .sort((a, b) => a - b)
    .map((score) => numberWithCommas(score));
  const rise = higher.length
    ? `Limits rise at ${
        higher.length === 1 ? 'a Creator Score' : 'Creator Scores'
      } of ${toStringList(higher)}`
    : undefined;
  const member = values.byTier?.member;
  const memberShare =
    tierRule || !member
      ? undefined
      : 'multiplier' in member
      ? `members get ${multiplierWords[member.multiplier] ?? `${member.multiplier} times as many`}`
      : `members get ${numberWithCommas(member.limit)}`;
  const ahead = [rise, memberShare].filter(Boolean).join(', and ');

  return [
    `You've reached today's limit of ${numberWithCommas(limit)} posts.`,
    ahead && `${ahead.charAt(0).toUpperCase()}${ahead.slice(1)}.`,
  ]
    .filter(Boolean)
    .join(' ');
}

export const COMMENT_RATE_LIMIT_MIN_CREATOR_SCORE = 1000;
export const REACTION_RATE_LIMIT_MIN_CREATOR_SCORE = 1000;
const comments = COMMENT_RATE_LIMIT_MIN_CREATOR_SCORE;
const reactions = REACTION_RATE_LIMIT_MIN_CREATOR_SCORE;

export const usageLimitDefs = [
  {
    id: 'posts.hourly',
    area: 'posts',
    kind: 'product',
    label: 'Posts per hour',
    window: rolling(HOUR),
    base: 2,
    appliesTo: 'first-day',
    message: 'New accounts have a lower hourly posting limit on their first day.',
  },
  {
    id: 'posts.daily',
    area: 'posts',
    kind: 'product',
    label: 'Posts per day',
    window: rolling(DAY),
    base: 20,
    byScore: [
      { minScore: 1000, limit: 60 },
      { minScore: 5000, limit: 150 },
    ],
    byTier: { member: { multiplier: 2 }, founder: { multiplier: 2 } },
    message: dailyPostLimitMessage,
  },
  {
    id: 'articles.first-day',
    area: 'articles',
    kind: 'abuse',
    label: 'Articles on the first day',
    window: rolling(HOUR),
    base: 0,
    appliesTo: 'first-day',
    configurable: false,
    message: 'You need to wait 24 hours after creating your account to create articles.',
  },
  {
    id: 'articles.daily',
    area: 'articles',
    kind: 'abuse',
    label: 'Articles per day',
    window: rolling(DAY),
    base: 3,
    byScore: [
      { minScore: 1000, limit: 5 },
      { minScore: 5000, limit: 10 },
      { minScore: 10000, limit: 20 },
    ],
  },
  {
    id: 'comments.hourly',
    area: 'comments',
    kind: 'product',
    label: 'Comments per hour',
    window: rolling(HOUR),
    base: 10,
    byScore: [{ minScore: comments, limit: 60 }],
  },
  {
    id: 'comments.daily',
    area: 'comments',
    kind: 'product',
    label: 'Comments per day',
    window: rolling(DAY),
    base: 40,
    byScore: [{ minScore: comments, limit: 480 }],
  },
  {
    id: 'reactions.minute',
    area: 'reactions',
    kind: 'abuse',
    label: 'Reactions per minute',
    window: rolling(60),
    base: 60,
    byScore: [{ minScore: reactions, limit: 100 }],
  },
  {
    id: 'reactions.ten-minutes',
    area: 'reactions',
    kind: 'abuse',
    label: 'Reactions per 10 minutes',
    window: rolling(10 * 60),
    base: 300,
    byScore: [{ minScore: reactions, limit: 500 }],
  },
  {
    id: 'reactions.hourly',
    area: 'reactions',
    kind: 'abuse',
    label: 'Reactions per hour',
    window: rolling(HOUR),
    base: 1000,
    byScore: [{ minScore: reactions, limit: 1500 }],
  },
  {
    id: 'reactions.daily',
    area: 'reactions',
    kind: 'abuse',
    label: 'Reactions per day',
    window: rolling(DAY),
    base: 5000,
    byScore: [{ minScore: reactions, limit: 8000 }],
  },
  {
    id: 'resource-loads.daily',
    area: 'resource-loads',
    kind: 'abuse',
    label: 'Model loads per day',
    window: rolling(DAY),
    base: 0,
    byTier: {
      bronze: { limit: 3 },
      silver: { limit: 6 },
      gold: { limit: 10 },
      founder: { limit: 10 },
    },
    // Only the free refusal: a member at their day's limit gets the generic refusal.
    message: ({ tierRule }) => (tierRule ? undefined : 'Loading models is a member benefit.'),
  },
  {
    id: 'resource-loads.hourly',
    area: 'resource-loads',
    kind: 'abuse',
    label: 'Model loads per hour',
    window: rolling(HOUR),
    base: 3,
    message: 'You can only queue a few model loads an hour. Try again shortly.',
  },
  {
    // One presign per image.
    id: 'auto-label.upload',
    area: 'auto-label',
    kind: 'abuse',
    label: 'Auto-label image uploads per minute',
    window: rolling(60),
    base: 1000,
  },
  {
    // One per batch of up to 16 images.
    id: 'auto-label.submit',
    area: 'auto-label',
    kind: 'abuse',
    label: 'Auto-label batches per minute',
    window: rolling(60),
    base: 100,
  },
  {
    // Every 5 s per in-flight workflow.
    id: 'auto-label.poll',
    area: 'auto-label',
    kind: 'abuse',
    label: 'Auto-label status checks per minute',
    window: rolling(60),
    base: 1500,
  },
  {
    // Counted by the gift claim itself (a calendar window), not by rateLimit().
    id: 'gifts.monthly',
    area: 'gifts',
    kind: 'product',
    label: 'Gift claims per month',
    window: { type: 'utc-month' },
    base: 3,
    byTier: {
      founder: { limit: 15 },
      bronze: { limit: 15 },
      silver: { limit: 30 },
      gold: { limit: 60 },
    },
    message: ({ limit }) =>
      `You've claimed your ${numberWithCommas(limit)} ${
        limit === 1 ? 'gift' : 'gifts'
      } for this month. To get this one, reach out to the person who gave you the link.`,
  },
  // ── Per-user App Platform caps, by membership tier. Read ONLY through `resolveUserAppCaps`
  // (`server/services/blocks/user-app-caps.service.ts`), which both enforcement and the
  // account Limits section call, so the two cannot disagree. Never `rateLimit()` rules.
  //
  // The per-tier table. Free is `base` (the doc store's `userBytes` / `userDocs` for storage);
  // Founder, a legacy paid
  // tier with no row in the table, gets Bronze's. Change a value with a `byTier` override in the
  // `usage-limits` KeyValue row, no deploy needed (an override's `byTier` replaces this one whole,
  // so it repeats every tier it keeps). `kind: 'abuse'` so an override can raise or lower these
  // but never `disabled` them (an unbounded spend or storage ceiling).
  {
    // Buzz spent through apps per UTC day, across all of a user's apps. Opting in to continue on
    // your own Buzz raises it to `OPT_IN_MULTIPLIER` (2) times this for the rest of the UTC day.
    id: 'apps.buzz-daily',
    area: 'apps',
    kind: 'abuse',
    label: 'Daily Buzz cap across apps',
    window: { type: 'utc-day' },
    base: 50_000,
    byTier: {
      founder: { limit: 75_000 },
      bronze: { limit: 75_000 },
      silver: { limit: 100_000 },
      gold: { limit: 200_000 },
    },
  },
  {
    // Bytes one user may hold in one app.
    id: 'apps.storage-bytes',
    area: 'apps',
    kind: 'abuse',
    label: 'Storage per app',
    window: { type: 'standing' },
    base: 2 * 1024 * 1024,
    byTier: {
      founder: { limit: 4 * 1024 * 1024 },
      bronze: { limit: 4 * 1024 * 1024 },
      silver: { limit: 8 * 1024 * 1024 },
      gold: { limit: 16 * 1024 * 1024 },
    },
  },
  {
    // Documents one user may hold in one app.
    id: 'apps.storage-docs',
    area: 'apps',
    kind: 'abuse',
    label: 'Documents per app',
    window: { type: 'standing' },
    base: 1_000,
    byTier: {
      founder: { limit: 2_000 },
      bronze: { limit: 2_000 },
      silver: { limit: 5_000 },
      gold: { limit: 10_000 },
    },
  },
  {
    // Sleeping (hibernated) apps one user may keep. At the limit a new hibernation is refused and
    // the app stays as it is. The refusal names the user's oldest sleeping app, which is deleted
    // only if the user confirms ("delete <name> to continue"); nothing is ever deleted on its own.
    id: 'apps.sleeping-count',
    area: 'apps',
    kind: 'abuse',
    label: 'Sleeping apps',
    window: { type: 'standing' },
    base: 5,
    byTier: {
      founder: { limit: 25 },
      bronze: { limit: 25 },
      silver: { limit: 50 },
      gold: { limit: 100 },
    },
  },
  {
    // Bytes of sleeping-app archives one user may keep, across all their sleeping apps.
    id: 'apps.sleeping-bytes',
    area: 'apps',
    kind: 'abuse',
    label: 'Sleeping app storage',
    window: { type: 'standing' },
    base: 100 * 1024 * 1024,
    byTier: {
      founder: { limit: 500 * 1024 * 1024 },
      bronze: { limit: 500 * 1024 * 1024 },
      silver: { limit: 1024 * 1024 * 1024 },
      gold: { limit: 2 * 1024 * 1024 * 1024 },
    },
  },
] as const satisfies readonly UsageLimitDef[];

export type UsageLimitId = (typeof usageLimitDefs)[number]['id'];

export const usageLimitDefsById: ReadonlyMap<string, UsageLimitDef> = new Map(
  usageLimitDefs.map((def) => [def.id, def as UsageLimitDef])
);

export function getUsageLimitDef(id: string): UsageLimitDef {
  const def = usageLimitDefsById.get(id);
  if (!def) throw new Error(`Unknown usage limit: ${id}`);
  return def;
}

/** The subset of a session user resolution reads. */
export type UsageLimitSubject = { tier?: string | null; meta?: unknown; createdAt?: Date | null };

function tierRuleFor(values: UsageLimitValues, tier: string | null | undefined) {
  const byTier = values.byTier;
  if (!byTier) return undefined;
  const key = (tier ?? 'free') as UsageLimitTier;
  const own = byTier[key];
  if (own) return own;
  return MEMBER_TIERS.includes(key) ? byTier.member : undefined;
}

/** The caller's limit under `values`: the score tier they reach, then their tier rule. */
export function resolveUsageLimitValues(
  values: UsageLimitValues,
  subject: UsageLimitSubject
): UsageLimitResolution {
  const score = creatorScoreFromMeta(subject.meta);
  let limit = values.base;
  let minScore = 0;
  for (const tier of values.byScore ?? []) {
    if (score >= tier.minScore && tier.limit > limit) {
      limit = tier.limit;
      minScore = tier.minScore;
    }
  }
  const tierRule = tierRuleFor(values, subject.tier);
  if (tierRule) {
    limit = 'limit' in tierRule ? tierRule.limit : Math.floor(limit * tierRule.multiplier);
  }
  return { limit, minScore, tierRule, values };
}

/** Whether the entry applies to the subject at all (its code-only condition and `disabled`). */
export function usageLimitApplies(
  def: UsageLimitDef,
  values: UsageLimitValues,
  subject: UsageLimitSubject
) {
  if (values.disabled) return false;
  if (def.appliesTo === 'first-day')
    return !!subject.createdAt && isBetweenToday(subject.createdAt);
  return true;
}

export function usageLimitMessage(def: UsageLimitDef, resolution: UsageLimitResolution) {
  return typeof def.message === 'function' ? def.message(resolution) : def.message;
}

/** A reference to registry entries, resolved per request by `rateLimit()`. */
export type UsageLimitRef = { usageLimitIds: readonly UsageLimitId[] };

/** Whether `rateLimit()` can count the window: its bucket keeps one day of attempts. */
export function isBucketCountable(window: UsageLimitWindow) {
  return window.type === 'rolling' && window.seconds <= 24 * 60 * 60;
}

/** Registry entries for `rateLimit()`; throws for a window the bucket cannot count. */
export function usageLimits(...ids: UsageLimitId[]): UsageLimitRef {
  for (const id of ids) {
    if (!isBucketCountable(getUsageLimitDef(id).window))
      throw new Error(`rateLimit() cannot count ${id}: its window is not a rolling day or less`);
  }
  return { usageLimitIds: ids };
}

export function isUsageLimitRef(value: unknown): value is UsageLimitRef {
  return !!value && typeof value === 'object' && 'usageLimitIds' in value;
}

export const USAGE_LIMITS_KEY = 'usage-limits';

/**
 * The KeyValue row `usage-limits`:
 *   { "version": 1, "limits": { "posts.daily": { "base": 25 } } }
 * Every field of an entry is optional; a present field replaces the code field whole: `byScore`
 * and `byTier` are not merged, so a `byTier` override repeats every tier it keeps, founder
 * included. The window and who an entry applies to are code-only: a rolling window longer than
 * the bucket's one-day retention would silently stop counting.
 */
const tierRuleSchema = z.union([
  z.strictObject({ limit: z.number() }),
  z.strictObject({ multiplier: z.number() }),
]);
const overrideEntrySchema = z.strictObject({
  base: z.number().optional(),
  byScore: z.array(z.strictObject({ minScore: z.number(), limit: z.number() })).optional(),
  byTier: z.partialRecord(z.enum([...usageLimitTiers, 'member']), tierRuleSchema).optional(),
  disabled: z.boolean().optional(),
});
export type UsageLimitOverride = z.infer<typeof overrideEntrySchema>;
export const usageLimitOverridesSchema = z.object({
  version: z.literal(1),
  limits: z.record(z.string(), z.unknown()),
});

export const MAX_USAGE_LIMIT_MULTIPLIER = 10;
export const MAX_USAGE_LIMIT_SCALE = 100;

/** The most any caller can get from these values, tier multipliers included. */
function largestLimit(values: UsageLimitValues) {
  const rules = Object.values(values.byTier ?? {});
  const tierLimits = rules.map((rule) => (rule && 'limit' in rule ? rule.limit : 0));
  const multiplier = Math.max(
    1,
    ...rules.map((rule) => (rule && 'multiplier' in rule ? rule.multiplier : 1))
  );
  const scoreLimits = [values.base, ...(values.byScore ?? []).map((tier) => tier.limit)];
  return Math.max(...scoreLimits.map((limit) => Math.floor(limit * multiplier)), ...tierLimits);
}

/**
 * Why `merged` may not be served for `def`, or undefined when it may. Every limit is an integer, at
 * least 1 (0 only in an entry whose code base is 0); none, scaled by a tier multiplier, exceeds 100x
 * the most the code gives any caller. Only a product limit can be disabled: an abuse cap holds.
 */
function boundsProblem(def: UsageLimitDef, merged: UsageLimitValues): string | undefined {
  if (merged.disabled && def.kind !== 'product') return 'only a product limit can be disabled';
  const max = MAX_USAGE_LIMIT_SCALE * largestLimit(def);
  const min = def.base === 0 ? 0 : 1;
  const limits = [
    merged.base,
    ...(merged.byScore ?? []).map((tier) => tier.limit),
    ...Object.values(merged.byTier ?? {}).flatMap((rule) =>
      rule && 'limit' in rule ? [rule.limit] : []
    ),
  ];
  for (const limit of limits) {
    if (!Number.isInteger(limit) || limit < min || limit > max)
      return `limit ${limit} outside [${min}, ${max}]`;
  }
  if (largestLimit(merged) > max) return `a tier multiplier takes a limit above ${max}`;
  for (const tier of merged.byScore ?? []) {
    if (!Number.isInteger(tier.minScore) || tier.minScore < 0)
      return `minScore ${tier.minScore} is not a whole number >= 0`;
  }
  for (const rule of Object.values(merged.byTier ?? {})) {
    if (rule && 'multiplier' in rule) {
      const { multiplier } = rule;
      if (!Number.isFinite(multiplier) || multiplier < 1 || multiplier > MAX_USAGE_LIMIT_MULTIPLIER)
        return `multiplier ${multiplier} outside [1, ${MAX_USAGE_LIMIT_MULTIPLIER}]`;
    }
  }
  return undefined;
}

export type UsageLimitConfig = ReadonlyMap<string, UsageLimitValues>;
export type UsageLimitFallback = { id: string; reason: string };

function codeValues(def: UsageLimitDef): UsageLimitValues {
  return { base: def.base, byScore: def.byScore, byTier: def.byTier, disabled: def.disabled };
}

export const defaultUsageLimitConfig: UsageLimitConfig = new Map(
  usageLimitDefs.map((def) => [def.id, codeValues(def as UsageLimitDef)])
);

/**
 * The values each entry serves given the stored row: its override where it parses and is in
 * bounds, else its code default. `fallbacks` names each override that was refused, and why.
 */
export function buildUsageLimitConfig(stored: unknown): {
  config: UsageLimitConfig;
  fallbacks: UsageLimitFallback[];
} {
  if (stored === undefined || stored === null)
    return { config: defaultUsageLimitConfig, fallbacks: [] };
  const envelope = usageLimitOverridesSchema.safeParse(stored);
  if (!envelope.success)
    return {
      config: defaultUsageLimitConfig,
      fallbacks: [{ id: '*', reason: 'row is not { version: 1, limits: {...} }' }],
    };

  const config = new Map(defaultUsageLimitConfig);
  const fallbacks: UsageLimitFallback[] = [];
  for (const [id, raw] of Object.entries(envelope.data.limits)) {
    const def = usageLimitDefsById.get(id);
    if (!def) {
      fallbacks.push({ id, reason: 'unknown id' });
      continue;
    }
    if (def.configurable === false) {
      fallbacks.push({ id, reason: 'not configurable' });
      continue;
    }
    const parsed = overrideEntrySchema.safeParse(raw);
    if (!parsed.success) {
      fallbacks.push({ id, reason: parsed.error.issues.map((issue) => issue.message).join('; ') });
      continue;
    }
    const merged: UsageLimitValues = { ...codeValues(def), ...parsed.data };
    const problem = boundsProblem(def, merged);
    if (problem) {
      fallbacks.push({ id, reason: problem });
      continue;
    }
    config.set(id, merged);
  }
  return { config, fallbacks };
}
