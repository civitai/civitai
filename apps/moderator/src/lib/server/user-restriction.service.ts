import type { UserRestrictionStatus } from '@civitai/db-schema/enums';
import { REDIS_SYS_KEYS } from '@civitai/redis';
import { dbRead } from './db';
import { getSysRedis } from './redis';

export const RESTRICTION_TYPE = 'generation';

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
  const { page, limit, status, username, userId, restrictionId } = query;

  const base = dbRead
    .selectFrom('UserRestriction as ur')
    .innerJoin('User as u', 'u.id', 'ur.userId')
    .where('ur.type', '=', RESTRICTION_TYPE)
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
