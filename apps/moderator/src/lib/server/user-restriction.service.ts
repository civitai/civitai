import type { UserRestrictionStatus } from '@civitai/db-schema/enums';
import { REDIS_SYS_KEYS } from '@civitai/redis';
import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';
import { getSysRedis } from './redis';

import { ORIGIN_FILTERS, type OriginFilter } from '$lib/restriction-filters';
import {
  defaultSortFor,
  RESTRICTION_TYPE,
  RESTRICTION_TYPES,
  type RestrictionType,
  type SortOrder,
} from '$lib/restriction-types';
import type { MediaType } from '../media/edge-url';
import type { TriggerOrigin } from '$lib/restrictions/origin';
import { planRecheck, recheckResult, type Recheck } from '$lib/restrictions/recheck';
import { isoTriggerTime } from '$lib/restrictions/trigger-evidence';
import { getPromptHighlightSegments } from '@civitai/mod-utils/prompt-audit';

// Re-exported so server-side callers have one import site for the queue's vocabulary. The definitions
// live in a client-safe module because the filter component needs them as values — see the note there.
export {
  defaultSortFor,
  RESTRICTION_TYPE,
  RESTRICTION_TYPES,
  RESTRICTION_TYPE_LABELS,
  RULINGS_WIRED_FOR,
  SORT_LABELS,
  SORT_ORDERS,
  unwiredRulingReason,
  type RestrictionType,
  type SortOrder,
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
  matchedText?: string;
  matchedField?: 'prompt' | 'negativePrompt';
  /** The NSFW-list text that opened the gate the matching rule needs. */
  gateWord?: string;
  /** Every rule that matched; the top-level fields are the first of these. */
  matches?: {
    category: string;
    matchedWord?: string;
    matchedRegex?: string;
    matchedText?: string;
    matchedField?: 'prompt' | 'negativePrompt';
    gateWord?: string;
  }[];
  imageId?: number | null;
  remixOfId?: number | null;
  /** Absent on rows written before origin was recorded. */
  origin?: TriggerOrigin;
  inputImages?: string[];
  inputVideo?: string;
  time?: string;
  reason?: string;
  text?: string;
  entityType?: string;
  entityId?: number;
  cleanup?: { kind: string; count: number; truncated: boolean; ids?: number[] } | null;
};

export type RestrictionTriggerView = RestrictionTrigger & { key: string };

export type RestrictionRow = {
  id: number;
  userId: number;
  username: string | null;
  userCreatedAt: Date;
  /** Read back rather than assumed: a by-id lookup is type-agnostic, so the caller cannot infer it. */
  type: string;
  status: UserRestrictionStatus;
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedMessage: string | null;
  resolvedReason: string | null;
  internalNotes: string | null;
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
  /** `remix`: some trigger came from a remix. `typed`: every prompt trigger recorded its origin and none came from a remix or the prompt enhancer. `unchanged-remix`: some trigger's remixed prompt matched the source image's stored prompt. */
  origin?: OriginFilter;
  /** Omitted means `defaultSortFor(status)`. */
  sort?: SortOrder;
};

export { ORIGIN_FILTERS, type OriginFilter };

// `triggers` is an array, or a single object on rows from before the backfill. jsonpath's default lax
// mode unwraps an array when a member is accessed on it, so one path covers both shapes.
// A legacy `remixOfId` beside enhancer evidence is read as an enhancer output by the screen, so it is
// not counted as a remix here either.
const jsonPath = (path: string) => sql`${sql.lit(path)}::jsonpath`;
const REMIX_SQL = sql<boolean>`(
  jsonb_path_exists(ur."triggers", ${jsonPath('$.origin.remix')})
  or jsonb_path_exists(ur."triggers", ${jsonPath(
    '$[*] ? (!exists(@.origin.enhancer) && @.remixOfId > 0)'
  )})
)`;
const ENHANCER_SQL = sql<boolean>`jsonb_path_exists(ur."triggers", ${jsonPath(
  '$.origin.enhancer'
)})`;
// A prompt trigger is one with a non-empty `prompt`. `$[*]` wraps the legacy single-object shape too.
const PROMPT_SQL = sql<boolean>`jsonb_path_exists(ur."triggers", ${jsonPath(
  '$[*] ? (@.prompt like_regex ".")'
)})`;
const UNRECORDED_SQL = sql<boolean>`jsonb_path_exists(ur."triggers", ${jsonPath(
  '$[*] ? (@.prompt like_regex "." && (!exists(@.origin) || @.origin == null))'
)})`;
// A failed lookup proves nothing about where the prompt came from, so it can never count as typed.
const INCOMPLETE_SQL = sql<boolean>`jsonb_path_exists(ur."triggers", ${jsonPath(
  '$[*] ? (@.origin.incomplete == true)'
)})`;
// Typed needs positive evidence: a row recorded before origin tracking has none, and neither does a
// row whose triggers are not prompts (a manual mute), so neither may be called typed.
const TYPED_SQL = sql<boolean>`(
  ${PROMPT_SQL} and not (${UNRECORDED_SQL} or ${REMIX_SQL} or ${ENHANCER_SQL} or ${INCOMPLETE_SQL})
)`;

// `promptMatch` is a server-side comparison against the source image's stored prompt, so this holds
// whether or not the moderator-facing verification has run.
const UNCHANGED_REMIX_SQL = sql<boolean>`jsonb_path_exists(ur."triggers", ${jsonPath(
  '$[*] ? (@.origin.remix.promptMatch == "identical")'
)})`;

const ORIGIN_PREDICATES: Record<OriginFilter, ReturnType<typeof sql<boolean>>> = {
  remix: REMIX_SQL,
  typed: TYPED_SQL,
  'unchanged-remix': UNCHANGED_REMIX_SQL,
};
const originPredicate = (origin: OriginFilter) => ORIGIN_PREDICATES[origin];

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
const toView = (raw: RestrictionTrigger, key: string): RestrictionTriggerView => {
  const trigger = { ...raw, time: isoTriggerTime(raw.time) };
  // A scam cleanup records up to thousands of ids for the restore; the page needs only the count.
  if (!trigger.cleanup) return { ...trigger, key };
  const { ids: _ids, ...cleanup } = trigger.cleanup;
  return { ...trigger, cleanup, key };
};

export async function getGenerationRestrictions(query: RestrictionQuery): Promise<{
  items: RestrictionRow[];
  totalCount: number;
}> {
  const {
    page,
    limit,
    type = RESTRICTION_TYPE,
    status,
    username,
    userId,
    restrictionId,
    origin,
    sort = defaultSortFor(status),
  } = query;

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
    .$if(!!username, (qb) => qb.where('u.username', 'ilike', `%${username}%`))
    .$if(!!origin, (qb) => qb.where(originPredicate(origin!)));

  const direction = sort === 'oldest' ? 'asc' : 'desc';

  const [rows, count] = await Promise.all([
    base
      .select([
        'ur.id',
        'ur.userId',
        'u.username',
        'u.createdAt as userCreatedAt',
        'ur.type',
        'ur.status',
        'ur.triggers',
        'ur.createdAt',
        'ur.resolvedAt',
        'ur.resolvedMessage',
        'ur.resolvedReason',
        'ur.internalNotes',
        'ur.userMessage',
        'ur.userMessageAt',
      ])
      .orderBy('ur.createdAt', direction)
      .orderBy('ur.id', direction)
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

/** Bounds the work for an account with an unusual number of distinct prompts. */
const RECHECK_LIMIT = 200;

/**
 * Re-runs the current word lists over triggers that recorded no match. Segments are of the NORMALISED
 * text, so they are shown beside the raw prompt, never in place of it. Server-only: it pulls the lists.
 */
export function recheckTriggers(triggers: readonly RestrictionTriggerView[]): Recheck {
  const plan = planRecheck(triggers);
  const results = plan.inputs.slice(0, RECHECK_LIMIT).map((input) => {
    return recheckResult(getPromptHighlightSegments(input.prompt, input.negativePrompt ?? null));
  });
  const byKey = Object.fromEntries(Object.entries(plan.byKey).filter(([, i]) => i < RECHECK_LIMIT));
  return { results, byKey };
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

export type RestrictionFacets = {
  /** By status, under the current origin filter. `any` is the sum. */
  status: Record<string, number>;
  /** By origin, under the current status filter. */
  origin: Record<'all' | OriginFilter, number>;
  /** By type, under the current status and origin filters. */
  type: Record<RestrictionType, number>;
};

/**
 * Counts for the queue's filter chips. Each facet ignores its own filter, so a chip shows what picking
 * it would give rather than the size of what is already on screen.
 */
export async function getRestrictionFacets(
  query: Pick<RestrictionQuery, 'type' | 'status' | 'username' | 'userId' | 'origin'>
): Promise<RestrictionFacets> {
  const { type = RESTRICTION_TYPE, status, username, userId, origin } = query;

  const anyType = dbRead
    .selectFrom('UserRestriction as ur')
    .innerJoin('User as u', 'u.id', 'ur.userId')
    .where('u.deletedAt', 'is', null)
    .$if(!!userId, (qb) => qb.where('ur.userId', '=', userId!))
    .$if(!!username, (qb) => qb.where('u.username', 'ilike', `%${username}%`));
  const base = anyType.$if(type !== 'any', (qb) => qb.where('ur.type', '=', type));

  const [byStatus, byOrigin, byType] = await Promise.all([
    base
      .$if(!!origin, (qb) => qb.where(originPredicate(origin!)))
      .select(['ur.status', (eb) => eb.fn.countAll<string>().as('count')])
      .groupBy('ur.status')
      .execute(),
    base
      .$if(!!status, (qb) => qb.where('ur.status', '=', status!))
      .select((eb) => [
        eb.fn.countAll<string>().as('all'),
        sql<string>`count(*) filter (where ${REMIX_SQL})`.as('remix'),
        sql<string>`count(*) filter (where ${TYPED_SQL})`.as('typed'),
        sql<string>`count(*) filter (where ${UNCHANGED_REMIX_SQL})`.as('unchangedRemix'),
      ])
      .executeTakeFirst(),
    anyType
      .$if(!!status, (qb) => qb.where('ur.status', '=', status!))
      .$if(!!origin, (qb) => qb.where(originPredicate(origin!)))
      .select(['ur.type', (eb) => eb.fn.countAll<string>().as('count')])
      .groupBy('ur.type')
      .execute(),
  ]);

  const typeCounts = Object.fromEntries(RESTRICTION_TYPES.map((t) => [t, 0])) as Record<
    RestrictionType,
    number
  >;
  for (const row of byType) typeCounts[row.type as RestrictionType] = Number(row.count);

  const statusCounts: Record<string, number> = {
    any: 0,
    Pending: 0,
    Upheld: 0,
    Overturned: 0,
  };
  for (const row of byStatus) {
    statusCounts[row.status] = Number(row.count);
    statusCounts.any += Number(row.count);
  }

  return {
    status: statusCounts,
    origin: {
      all: Number(byOrigin?.all ?? 0),
      remix: Number(byOrigin?.remix ?? 0),
      typed: Number(byOrigin?.typed ?? 0),
      'unchanged-remix': Number(byOrigin?.unchangedRemix ?? 0),
    },
    type: typeCounts,
  };
}

export type RemixSource = {
  id: number;
  url: string;
  type: MediaType;
  nsfwLevel: number;
  /** The stored generation prompt, for the diff against what was submitted. */
  prompt: string | null;
};

export async function getRemixSources(ids: readonly number[]): Promise<RemixSource[]> {
  if (!ids.length) return [];
  const rows = await dbRead
    .selectFrom('Image as i')
    .select([
      'i.id',
      'i.url',
      'i.type',
      'i.nsfwLevel',
      sql<string | null>`i."meta" ->> 'prompt'`.as('prompt'),
    ])
    .where('i.id', 'in', [...ids])
    .execute();
  return rows.map((r) => ({ ...r, type: r.type as MediaType }));
}
