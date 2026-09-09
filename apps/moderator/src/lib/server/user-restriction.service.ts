import type { UserRestrictionStatus } from '@civitai/db-schema/enums';
import { REDIS_SYS_KEYS } from '@civitai/redis';
import { dbRead } from './db';
import { getSysRedis } from './redis';

import { RESTRICTION_TYPE, type RestrictionType } from '$lib/restriction-types';

// Re-exported so server-side callers have one import site for the queue's vocabulary. The definitions
// live in a client-safe module because the filter component needs them as values — see the note there.
export {
  RESTRICTION_TYPE,
  RESTRICTION_TYPES,
  RESTRICTION_TYPE_LABELS,
  RULINGS_WIRED_FOR,
  unwiredRulingReason,
  type RestrictionType,
} from '$lib/restriction-types';

/** One prohibited request recorded against a restriction. Every field is optional: the shape is
 *  written by two producers (the live audit and the ClickHouse backfill) and older rows predate both. */
export type RestrictionTrigger = {
  prompt?: string;
  negativePrompt?: string;
  source?: string;
  category?: string;
  matchedWord?: string;
  matchedRegex?: string;
  imageId?: number | null;
  remixOfId?: number | null;
  inputImages?: string[];
  inputVideo?: string;
  time?: string;
};

export type RestrictionTriggerView = RestrictionTrigger & { key: string };

export type RestrictionRow = {
  id: number;
  userId: number;
  username: string | null;
  /** Read back rather than assumed: a by-id lookup is type-agnostic, so the caller cannot infer it. */
  type: string;
  status: UserRestrictionStatus;
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedMessage: string | null;
  userMessage: string | null;
  userMessageAt: Date | null;
  triggers: RestrictionTriggerView[];
};

export type RestrictionQuery = {
  page: number;
  limit: number;
  /**
   * Omitted means `generation`, so every pre-seam caller keeps the queue it had.
   *
   * `'any'` drops the filter, and exists for the ONE caller that addresses a row by its primary key —
   * where a type predicate cannot make the answer more correct, only turn a real row into a 404. It is
   * deliberately absent from the page's query schema, so no URL can put the list view into it.
   */
  type?: RestrictionType | 'any';
  status?: UserRestrictionStatus;
  username?: string;
  userId?: number;
  restrictionId?: number;
};

const asTriggerArray = (value: unknown): RestrictionTrigger[] => {
  if (Array.isArray(value)) return value as RestrictionTrigger[];
  // Pre-backfill rows stored a single trigger object rather than an array.
  return value && typeof value === 'object' ? [value as RestrictionTrigger] : [];
};

/**
 * The prompt is passed through UNCHANGED.
 *
 * It was briefly run through `getPromptHighlightSegments` for category colouring, which normalises as it
 * goes — decoding HTML entities and stripping combining marks. On a page whose subject IS evasion that
 * is the wrong trade: it folds away the technique being reviewed, so the moderator stops seeing what the
 * user actually typed. Highlighting happens in the component against the recorded `matchedWord` by
 * literal search; the stored `matchedRegex` is attacker-influenced text and is never executed.
 */
const toView = (trigger: RestrictionTrigger, key: string): RestrictionTriggerView => ({
  ...trigger,
  key,
});

export async function getGenerationRestrictions(query: RestrictionQuery): Promise<{
  items: RestrictionRow[];
  totalCount: number;
}> {
  const { page, limit, type = RESTRICTION_TYPE, status, username, userId, restrictionId } = query;

  // 🔴 The type predicate is what separates one review queue from another, and it is applied for every
  // value of `type` except the explicit `'any'`. It is written as a `$if` on a NEGATIVE so that
  // omitting `type` still filters — folding it in with the optional predicates below on a truthiness
  // test would make "no type given" mean "every type", i.e. silently render one queue's rows in
  // another's. The count query is built off this same `base`, so the total cannot drift from the list.
  const base = dbRead
    .selectFrom('UserRestriction as ur')
    .innerJoin('User as u', 'u.id', 'ur.userId')
    .$if(type !== 'any', (qb) => qb.where('ur.type', '=', type))
    .where('u.deletedAt', 'is', null)
    .$if(!!status, (qb) => qb.where('ur.status', '=', status!))
    .$if(!!userId, (qb) => qb.where('ur.userId', '=', userId!))
    .$if(!!restrictionId, (qb) => qb.where('ur.id', '=', restrictionId!))
    .$if(!!username, (qb) => qb.where('u.username', 'ilike', `%${username}%`));

  const [rows, count] = await Promise.all([
    base
      .select([
        'ur.id',
        'ur.userId',
        'u.username',
        'ur.type',
        'ur.status',
        'ur.triggers',
        'ur.createdAt',
        'ur.resolvedAt',
        'ur.resolvedMessage',
        'ur.userMessage',
        'ur.userMessageAt',
      ])
      .orderBy('ur.createdAt', 'desc')
      .limit(limit)
      .offset((page - 1) * limit)
      .execute(),
    base
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .executeTakeFirst()
      .then((r) => Number(r?.count ?? 0)),
  ]);

  return {
    items: rows.map((row) => ({
      ...row,
      triggers: asTriggerArray(row.triggers).map((t, i) => toView(t, `${row.id}-${i}`)),
    })),
    totalCount: count,
  };
}

export type SuspiciousMatch = {
  odometer: number;
  userId: number;
  prompt: string;
  negativePrompt?: string;
  check: string;
  matchedText: string;
  regex?: string;
};

/**
 * The same `system:suspicious-audit-matches` list the main app's review tooling reads — shared Redis
 * infrastructure, not a callback. The 1000-entry trim is part of the contract: without it the list
 * grows unbounded on a key nothing else prunes.
 */
export async function saveSuspiciousMatches(
  matches: SuspiciousMatch[],
  moderatorId: number
): Promise<number> {
  if (!matches.length) return 0;
  const redis = getSysRedis();
  const flaggedAt = new Date().toISOString();

  for (const match of matches) {
    await redis.lPush(
      REDIS_SYS_KEYS.SYSTEM.SUSPICIOUS_AUDIT_MATCHES,
      JSON.stringify({ ...match, flaggedBy: moderatorId, flaggedAt })
    );
  }
  await redis.lTrim(REDIS_SYS_KEYS.SYSTEM.SUSPICIOUS_AUDIT_MATCHES, 0, 999);

  return matches.length;
}
