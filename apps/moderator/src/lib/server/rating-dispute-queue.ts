import { fail } from '@sveltejs/kit';
import type { Action } from '@sveltejs/kit';
import type { ExpressionBuilder, SelectQueryBuilder } from 'kysely';
import { z } from 'zod';
import { sql } from '@civitai/db/kysely';
import { NsfwLevel } from '@civitai/shared';
import { textScanRaisedMinLevel } from '@civitai/shared/rated-entity-sql';
import { RATING_REVIEW_ENTITY_TYPES } from '@civitai/shared/rating-review';
import { dbRead } from './db';
import { escapeLike } from './like';
import { int4Id, parseQueryKeys } from './query';
import { resolveRatingReviewAction } from './rating-review-actions';
import {
  getRatingReviewImagesBatch,
  hydrateRatingReviews,
  ratingReviewImagesKey,
  ratingReviewRowQuery,
  type RatingReviewImages,
  type RatingReviewRow,
} from './rating-reviews.service';
import {
  DEFAULT_DISPUTE_TAB,
  defaultDisputeSort,
  DISPUTE_SORTS,
  DISPUTE_TAB_TYPES,
  DISPUTE_TABS,
  type DisputeSort,
  type DisputeTab,
} from '$lib/rating-dispute';
import type { RatingReviewStatusFilter } from '$lib/rating-review';

const PAGE_SIZE = 50;

const STATUSES = ['Pending', 'Actioned', 'Unactioned'] as const;
const ASKS = ['lower', 'higher'] as const;

export type DisputeFilters = {
  tab: DisputeTab;
  status: RatingReviewStatusFilter;
  ask: (typeof ASKS)[number] | undefined;
  scan: 'raised' | undefined;
  sort: DisputeSort;
  owner: number | undefined;
};

export type RatingDisputeRow = RatingReviewRow & {
  ownerDisputeCount: number;
  preview: RatingReviewImages;
};

export type DisputeFacets = {
  tabs: Record<DisputeTab, number>;
  chips: { lower: number; higher: number; raised: number };
};

// Read key by key (`parseQueryKeys`), not through `parseQuery`: that walks `searchParams.keys()`,
// which makes SvelteKit rerun the load on a query param it does not use.
const querySchema = z.object({
  tab: z.enum(DISPUTE_TABS).catch(DEFAULT_DISPUTE_TAB),
  status: z.enum(STATUSES).catch('Pending'),
  ask: z.enum(ASKS).optional().catch(undefined),
  scan: z.literal('raised').optional().catch(undefined),
  sort: z.enum(DISPUTE_SORTS).optional().catch(undefined),
  q: z.string().trim().max(100).catch(''),
  page: z.coerce.number().int().min(1).max(500).catch(1),
  selected: int4Id.optional().catch(undefined),
  owner: int4Id.optional().catch(undefined),
});

// Both sides of the join the filters read; the select list is the caller's.
type FilterBase = SelectQueryBuilder<any, any, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// Types whose text-scan verdict only raises at R; the threshold itself stays in `isTextScanRaised`'s
// module so this SQL cannot drift from the predicate the row's `scan` badge uses.
const RAISED_AT_R = RATING_REVIEW_ENTITY_TYPES.filter(
  (t) => textScanRaisedMinLevel(t) === NsfwLevel.R
);

/** `isTextScanRaised`, as SQL over `rr`: a scan with a `version` whose level reaches the type's floor. */
const scanRaisedSql = sql<boolean>`EXISTS (
  SELECT 1 FROM "EntityModeration" em
  WHERE em."entityType" = rr."entityType" AND em."entityId" = rr."entityId"
    AND COALESCE(jsonb_typeof(em."result" -> 'version'), 'null') <> 'null'
    AND em."nsfwLevel" >= CASE WHEN rr."entityType" IN (${sql.join(RAISED_AT_R)})
      THEN ${NsfwLevel.R}::int ELSE ${textScanRaisedMinLevel('Post')}::int END)`;

const askLowerSql = sql<boolean>`rr."suggestedLevel" < rr."currentLevel"`;
const askHigherSql = sql<boolean>`rr."suggestedLevel" > rr."currentLevel"`;

function searchPredicate(q: string) {
  if (!q) return null;
  const asId = /^\d+$/.test(q) ? int4Id.safeParse(q) : null;
  if (asId?.success) return sql<boolean>`(rr."id" = ${asId.data} OR rr."entityId" = ${asId.data})`;
  // A number too large for an id is not a username either; it lands here and the prefix simply
  // matches nobody.
  return sql<boolean>`owner."username" ILIKE ${escapeLike(q) + '%'}`;
}

function withScope<QB extends FilterBase>(
  qb: QB,
  scope: { status: RatingReviewStatusFilter; q: string; tab?: DisputeTab; owner?: number }
): QB {
  let out = qb.where('rr.status', '=', scope.status) as QB;
  if (scope.tab) out = out.where('rr.entityType', 'in', [...DISPUTE_TAB_TYPES[scope.tab]]) as QB;
  if (scope.owner) out = out.where('rr.userId', '=', scope.owner) as QB;
  const search = searchPredicate(scope.q);
  if (search) out = out.where(search) as QB;
  return out;
}

function withFilters<QB extends FilterBase>(qb: QB, f: Pick<DisputeFilters, 'ask' | 'scan'>): QB {
  let out = qb;
  if (f.ask === 'lower') out = out.where(askLowerSql) as QB;
  if (f.ask === 'higher') out = out.where(askHigherSql) as QB;
  if (f.scan === 'raised') out = out.where(scanRaisedSql) as QB;
  return out;
}

const countsBase = () =>
  dbRead.selectFrom('RatingReview as rr').innerJoin('User as owner', 'owner.id', 'rr.userId');

async function getFacets(scope: {
  status: RatingReviewStatusFilter;
  q: string;
  tab: DisputeTab;
  owner?: number;
}): Promise<DisputeFacets> {
  const [byType, chips] = await Promise.all([
    withScope(countsBase(), { status: scope.status, q: scope.q, owner: scope.owner })
      .select([
        'rr.entityType',
        (eb: ExpressionBuilder<any, any>) => eb.fn.countAll<string>().as('c'),
      ]) // eslint-disable-line @typescript-eslint/no-explicit-any
      .groupBy('rr.entityType')
      .execute(),
    withScope(countsBase(), scope)
      .select([
        sql<string>`count(*) FILTER (WHERE ${askLowerSql})`.as('lower'),
        sql<string>`count(*) FILTER (WHERE ${askHigherSql})`.as('higher'),
        sql<string>`count(*) FILTER (WHERE ${scanRaisedSql})`.as('raised'),
      ])
      .executeTakeFirst(),
  ]);
  const tabs: Record<DisputeTab, number> = { posts: 0, models: 0, articles: 0, other: 0 };
  for (const row of byType)
    for (const tab of DISPUTE_TABS)
      if ((DISPUTE_TAB_TYPES[tab] as readonly string[]).includes(row.entityType))
        tabs[tab] += Number(row.c);
  return {
    tabs,
    chips: {
      lower: Number(chips?.lower ?? 0),
      higher: Number(chips?.higher ?? 0),
      raised: Number(chips?.raised ?? 0),
    },
  };
}

/** Each review's place in its owner's disputes, oldest first: how many of the owner's reviews have an id up to its own. */
async function ownerDisputeOrdinals(reviewIds: number[]): Promise<Map<number, number>> {
  if (!reviewIds.length) return new Map();
  const { rows } = await sql<{ id: number; n: number }>`
    SELECT r."id", (SELECT count(*) FROM "RatingReview" o WHERE o."userId" = r."userId" AND o."id" <= r."id")::int AS n
    FROM "RatingReview" r
    WHERE r."id" IN (${sql.join(reviewIds)})`.execute(dbRead);
  return new Map(rows.map((r) => [r.id, r.n]));
}

/** The queue rows plus what only the triage view shows: each dispute's number among its owner's and the preview strip. */
async function decorate(rows: RatingReviewRow[]): Promise<RatingDisputeRow[]> {
  const [owners, previews] = await Promise.all([
    ownerDisputeOrdinals(rows.map((r) => r.id)),
    getRatingReviewImagesBatch(rows),
  ]);
  return rows.map((r) => ({
    ...r,
    ownerDisputeCount: owners.get(r.id) ?? 0,
    preview: previews.get(ratingReviewImagesKey(r.entityType, r.entityId)) ?? {
      total: 0,
      images: [],
    },
  }));
}

/**
 * The two-pane triage read for the rating-dispute queue. The whole page ships at once: selection is
 * client state, so every row carries its own preview images and its number among the owner's disputes.
 */
export async function ratingDisputeTriageLoad(url: URL) {
  const parsed = parseQueryKeys(url, querySchema);
  const { tab, status, ask, scan, q, page, selected, owner } = parsed;
  const sort = parsed.sort ?? defaultDisputeSort(status);
  const filters: DisputeFilters = { tab, status, ask, scan, sort, owner };

  const scoped = () =>
    withFilters(withScope(ratingReviewRowQuery(), { status, q, tab, owner }), filters);
  const dir = sort === 'oldest' ? 'asc' : 'desc';
  const sortColumn = status === 'Pending' ? 'rr.createdAt' : 'rr.resolvedAt';

  const [records, total, facets] = await Promise.all([
    scoped()
      .orderBy(sortColumn, (ob) => (dir === 'asc' ? ob.asc().nullsLast() : ob.desc().nullsLast()))
      .orderBy('rr.id', dir)
      .limit(PAGE_SIZE + 1)
      .offset((page - 1) * PAGE_SIZE)
      .execute(),
    withFilters(withScope(countsBase(), { status, q, tab, owner }), filters)
      .select((eb: ExpressionBuilder<any, any>) => eb.fn.countAll<string>().as('c')) // eslint-disable-line @typescript-eslint/no-explicit-any
      .executeTakeFirst(),
    // Counts are decoration: a failed count must not take the list down with it.
    getFacets({ status, q, tab, owner }).catch((err) => {
      console.error('Rating dispute facet counts failed', err);
      return undefined;
    }),
  ]);

  const hasMore = records.length > PAGE_SIZE;
  const pageRows = await hydrateRatingReviews(records.slice(0, PAGE_SIZE));

  // A deep link may name a review the filters or paging leave off this page; it opens regardless
  // rather than the pane silently showing another row. Any status, any tab.
  let pinnedRows: RatingReviewRow[] = [];
  let selectedMissing: number | null = null;
  if (selected && !pageRows.some((r) => r.id === selected)) {
    pinnedRows = await hydrateRatingReviews(
      await ratingReviewRowQuery().where('rr.id', '=', selected).execute()
    );
    if (!pinnedRows.length) selectedMissing = selected;
  }

  const decorated = await decorate([...pageRows, ...pinnedRows]);
  const items = decorated.slice(0, pageRows.length);
  const pinned: RatingDisputeRow | null = decorated[pageRows.length] ?? null;

  return {
    items,
    pinned,
    selectedMissing,
    facets,
    totalCount: Number(total?.c ?? 0),
    page,
    hasMore,
    offset: (page - 1) * PAGE_SIZE,
    filters,
    q,
    fullBleed: true,
    headerInline: true,
  };
}

const resolveSchema = z.object({
  reviewId: int4Id,
  appliedLevel: z.coerce.number().int().positive(),
  modComment: z
    .string()
    .trim()
    .max(1000)
    .optional()
    .transform((v) => v || undefined),
});

/**
 * The `resolve` form action. Access is gated centrally (hooks.server.ts) on the page's path; the
 * per-entity level rule lives in the service. A refusal is returned as `fail`, never thrown, so the
 * triage shell can show it against the review it belongs to.
 */
export const resolveRatingDisputeAction: Action = async ({ request, locals }) => {
  const parsed = resolveSchema.safeParse(Object.fromEntries(await request.formData()));
  if (!parsed.success) return fail(400, { error: 'Invalid resolution' });
  const result = await resolveRatingReviewAction({ ...parsed.data, userId: locals.user.id });
  if (!result.ok)
    return fail(409, {
      error: result.error,
      subject: `Review #${parsed.data.reviewId}`,
      key: parsed.data.reviewId,
    });
  return { success: true, status: result.status };
};
