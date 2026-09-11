import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';
import * as z from 'zod';

import {
  parseSubjectUserId,
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import {
  getAllCollections,
  getCollectionItemCount,
  getUserCollectionsWithPermissions,
} from '~/server/services/collection.service';
import {
  collectionWithinCeiling,
  getCollectionPlayableSample,
  getFallbackCoverImages,
  getFollowedCollectionIds,
  hydrateBlockSubject,
  toCoverFields,
} from '~/server/services/blocks/block-collections.service';
import {
  getWindowedCollectionRanking,
  isWindowedPeriod,
} from '~/server/services/blocks/block-collection-popularity.service';
import { resolveCatalogBrowsingLevel } from '~/server/utils/block-catalog-maturity';
import { checkBlockCatalogRateLimit } from '~/server/utils/block-catalog-rate-limit';
import { getRegion, isRegionRestricted } from '~/server/utils/region-blocking';
import { CollectionSort } from '~/server/common/enums';
import {
  CollectionItemStatus,
  CollectionReadConfiguration,
  CollectionType,
  MetricTimeframe,
} from '~/shared/utils/prisma/enums';

/**
 * GET /api/v1/blocks/collections?mode=public|mine&query&sort&period&cursor&limit
 *
 * Block-token collection DISCOVERY for App Blocks. Scope `collections:read:self`.
 *
 *   - mode=public → public collections (name-searchable, sortable) via the
 *     existing `getAllCollections` service (privacy pinned to Public).
 *   - mode=mine   → the SUBJECT's OWN collections (public + private) via the
 *     existing `getUserCollectionsWithPermissions` service, keyed on the verified
 *     token subject (never a client-supplied userId).
 *
 * PERIOD — "popular this day / week / month / year / all time".
 *
 * 🔴 AN ABSENT `period` IS NOT `AllTime` WITH EXTRA STEPS — IT TAKES LITERALLY THE
 * SAME CODE PATH AS BEFORE THIS PARAMETER EXISTED, AND EMITS THE SAME BODY. There
 * is no default value: `windowedPeriod` below is `null` for an absent period, for
 * `AllTime`, for `mode=mine` and for any sort other than the popularity one, and
 * every one of those falls into the untouched Postgres walk. The `period` /
 * `source` / `sourceReason` response fields are emitted ONLY when a `period` was
 * supplied, so an existing caller's response is byte-identical to what it was.
 * That is the whole compatibility contract and it is pinned by a test that diffs
 * the two bodies key-for-key.
 *
 * 🔴 `period` MODIFIES POPULARITY, SO IT IS HONOURED ONLY FOR THE POPULARITY SORT
 * (`sort=popular` / `Most Followers`). `sort=newest&period=week` does NOT silently
 * become a popularity feed — "newest" would stop meaning newest. A period sent
 * with any other sort is accepted and ignored, and the response says which source
 * actually served it, so the no-op is visible from the outside rather than being a
 * parameter that mysteriously does nothing.
 *
 * 🔴 DAY/WEEK/MONTH/YEAR COME FROM CLICKHOUSE, ALL-TIME FROM POSTGRES, AND THAT
 * SPLIT IS FORCED BY THE DATA. `entityMetricDailyAgg_history_v2` begins 2025-11-06,
 * so a ClickHouse "all time" would silently mean "since November". All-time keeps
 * the pre-existing `getAllCollections` ordering. See
 * `~/server/services/blocks/block-collection-popularity.service` for the window
 * arithmetic and why the table choice matters.
 *
 * 🔴 CLICKHOUSE RANKS IDS WITH NO NOTION OF PRIVACY OR TYPE. Every id it returns is
 * re-read through `getAllCollections` with `privacy: [Public]` + `types: [Image]`
 * — the SAME predicates the untouched path uses — so a private or Model/Article
 * collection that ranks first is simply absent from the hydrate and is walked past
 * like a maturity-clamped row. Nothing from ClickHouse is rendered directly.
 *
 * 🔴 THE CURSOR MEANS DIFFERENT THINGS ON THE TWO PATHS, DELIBERATELY. The Postgres
 * path keeps its inclusive KEYSET cursor on collection id (both its orderings are
 * id/createdAt-monotonic, so a keyset works and is cheap). A ClickHouse ranking is
 * ordered by summed followers, which is neither monotonic in id nor stable enough
 * to keyset on, so that path uses an OFFSET into the bounded top-N leaderboard
 * instead. A client round-trips whatever `nextCursor` it was handed, and a feed
 * does not change its `period` mid-scroll, so the two never mix in practice — but
 * do not "unify" them: an offset fed to the keyset path silently returns the wrong
 * page rather than an error.
 *
 * Maturity: collections whose own `nsfwLevel` exceeds the token's clamped ceiling
 * (`claims.maxBrowsingLevel`, region-narrowed) are dropped — a SFW-domain block
 * can't surface a mature collection in discovery. (Per-item maturity is enforced
 * on the detail endpoint where the media is actually read.)
 *
 * 🔴 THE COLLECTION-LEVEL `nsfwLevel` CANNOT SEPARATE A MOSTLY-SAFE COLLECTION
 * FROM A MOSTLY-MATURE ONE, which is why the clamped count below exists. It is a
 * bitmask OR-ed over the collection's items, so a contest collection that is 97%
 * safe and a mature collection that is 1% safe both carry the same value (29 =
 * PG|R|X|XXX) and both INTERSECT a SFW ceiling. Gating harder on that value is not
 * an option: strict containment (`nsfwLevel & ~browsingLevel === 0`) was measured
 * against the live population and drops 87.5% of the first discovery page,
 * including the large contest collections that are the best content on a SFW
 * domain. The separating signal is HOW MUCH OF THE COLLECTION SURVIVES THE
 * CEILING, sampled — see `MIN_PLAYABLE_FRACTION` and `PLAYABLE_SAMPLE_SIZE`.
 *
 * Response: `{ items: [{ id, name, description, coverImageUrl, coverNsfwLevel?,
 *   itemCount, curator:{ userId, username }, isPublic, followed }], nextCursor }`
 *   — plus `period`, `source` (`'clickhouse' | 'postgres'`) and, when the request
 *   did not get the source it asked for, `sourceReason`. Those three appear ONLY
 *   when the request supplied a `period`; see the compatibility note above.
 *
 * 🔴 `coverNsfwLevel` IS THE LEVEL OF THE COVER BEING SERVED — NOT THE
 * COLLECTION'S `nsfwLevel`, AND THE NAME IS DELIBERATE. The collection-level value
 * is the OR-ed bitmask described above, which cannot separate a 97%-safe contest
 * collection from a 1%-safe mature one; a field named `nsfwLevel` on this response
 * would invite exactly that confusion. This one describes a SINGLE IMAGE: whichever
 * image `coverImageUrl` resolves to — the primary `Collection.image` when it is
 * usable, otherwise the maturity-clamped fallback, which is the collection's
 * NEWEST permitted accepted item (not a "highest-rated representative"; nothing
 * here ranks items). Both fields are produced together by `toCoverFields` from the
 * one chosen image, so they can never describe different images.
 *
 * 🔴 IT IS OMITTED WHEN THERE IS NO COVER, AND `0` IS A REAL LEVEL. A consumer
 * reads `undefined` as "no claim — use your own domain ceiling" and any supplied
 * value as authoritative, so `0` (unrated) must never stand in for "absent".
 *
 * 🔴 `itemCount` DIFFERS BY MODE, DELIBERATELY. In `mode=mine` it is CLAMPED to
 * the token's ceiling — that branch counts only the subject's own collections, a
 * bounded set with no over-fetch window, so the exact clamped count is affordable
 * there. In `mode=public` it is the collection's ADVERTISED (unclamped) size: the
 * exact clamped count over the discovery over-fetch window is a ~31× regression
 * on this endpoint (measured; see `PLAYABLE_SAMPLE_SIZE`), and the sampled
 * fraction that replaces it is an ESTIMATE, which a field that reads as exact
 * must not carry. The advertised number is not a lie — it is the collection's
 * real size — and the playable floor now guarantees that most of it is playable.
 */

export const config = { api: { responseLimit: false } };

// Block-friendly `sort` aliases → the internal CollectionSort enum. Accepted IN
// ADDITION to the raw enum values (backward-compat), so a block may send the
// simple `newest`/`popular` OR the underlying `Newest`/`Most Followers`. There is
// no media-count popularity sort on the service — `popular` maps to the closest
// available ranking, MostContributors ('Most Followers').
const SORT_ALIAS: Record<string, CollectionSort> = {
  newest: CollectionSort.Newest,
  popular: CollectionSort.MostContributors,
};

/**
 * The PLAYABLE-FRACTION FLOOR: the share of a collection's SAMPLED accepted items
 * that must survive the viewer's maturity ceiling for that collection to be worth
 * surfacing in PUBLIC discovery.
 *
 * A collection at 1% is not a collection the viewer can browse; it is a card
 * promising 2,080 items that opens onto 19. Twenty percent is the point measured
 * to separate the two live populations — the mostly-safe contest collections sit
 * far above it and the mature ones far below — without needing a second signal.
 *
 * 🔴 A RANKING HEURISTIC, NOT A SAFETY GATE, AND IT IS FED BY A SAMPLE. The
 * fraction is computed over the newest `PLAYABLE_SAMPLE_SIZE` items, not over the
 * whole collection (the exact clamped count is unaffordable here — the cost,
 * accuracy and order-sensitivity measurements live on that constant). Nothing on
 * this path protects a viewer from mature media: per-item maturity is enforced on
 * the DETAIL endpoint where the media is read, and on the cover via
 * `getFallbackCoverImages`. A collection kept by this floor can still be 79%
 * mature.
 *
 * 🔴 DISCOVERY ONLY. It is deliberately NOT applied in `mode=mine`; see the drop
 * comment on the public branch and the note above the `mine` branch.
 */
export const MIN_PLAYABLE_FRACTION = 0.2;

/**
 * Does `playable` of `sampled` items clear {@link MIN_PLAYABLE_FRACTION}?
 *
 * 🔴 THE ZERO CASE IS AN EXPLICIT BRANCH, NOT A DIVISION. A collection with
 * nothing sampled gives `0 / 0 = NaN`, and every comparison against NaN is false
 * — so without this guard it would be silently DROPPED by a filter that has
 * nothing to say about it. This filter exists to catch a MATURITY MISMATCH
 * between what a card advertises and what it can serve, and a collection with no
 * items has no mismatch to detect. Whether an empty collection belongs in
 * discovery at all is a separate product question this must not decide as a side
 * effect.
 */
export function meetsPlayableFloor(sampled: number, playable: number): boolean {
  if (sampled <= 0) return true;
  return playable / sampled >= MIN_PLAYABLE_FRACTION;
}

const querySchema = z.object({
  mode: z.enum(['public', 'mine']).default('public'),
  query: z.string().trim().max(100).optional(),
  // Preprocess maps a friendly alias (case-insensitive) to the enum value; a raw
  // enum value passes through unchanged; undefined falls to the enum default.
  sort: z.preprocess(
    (v) => (typeof v === 'string' ? SORT_ALIAS[v.toLowerCase()] ?? v : v),
    z.enum(CollectionSort).default(CollectionSort.Newest)
  ),
  // 🔴 NO `.default()`, ON PURPOSE. An absent `period` has to stay distinguishable
  // from an explicit `AllTime` at runtime — not because they order differently
  // (they do not), but because the `source`/`period` response fields are emitted
  // only for an explicit request, which is what keeps an existing caller's body
  // byte-identical. A `.default(AllTime)` here would erase that distinction and
  // change every legacy response.
  period: z.enum(MetricTimeframe).optional(),
  // Cursor. Postgres path: an inclusive KEYSET cursor on the collection id (both
  // modes order id DESC). ClickHouse path: an OFFSET into the bounded windowed
  // leaderboard. See the header note — same field, two meanings, one per path.
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(24),
});

/** The pre-existing Postgres over-fetch. Unchanged; extracted only to be named. */
const overfetchWidth = (limit: number) => limit * 4 + 1;

/** Hard ceiling on how many ranked ids one request may hydrate. See below. */
const CH_HYDRATE_MAX = 1000;

/**
 * How many RANKED IDS the ClickHouse path hydrates per request.
 *
 * 🔴 SIX TIMES THE POSTGRES OVER-FETCH, BECAUSE THE TWO PATHS DISCARD ROWS AT
 * WILDLY DIFFERENT RATES AND SHARING A MULTIPLIER WOULD HAVE SHIPPED A 4-ITEM
 * PAGE. The Postgres walk over-fetches `limit * 4 + 1` because it loses only the
 * maturity clamp and the playable floor — its source query already applied
 * `privacy` and `types` as SQL predicates, so nothing it fetches is a type reject.
 * A ClickHouse ranking has not applied them at all: measured on the production
 * replica 2026-09-11, the Month window's top 1,000 ids are 100% `Public` but only
 * **81** are `CollectionType.Image` — 914 are Model collections. A `limit * 4 + 1`
 * window (97 ids) hydrates **21** showable rows against a default `limit` of 24,
 * i.e. every page short, forever.
 *
 * At `limit * 24 + 1` a default page hydrates 577 ids for 53 showable rows and
 * fills. Cost of the widening, measured on the replica over the same window (the
 * hydrate is an `id IN (…)` primary-key scan, so it barely notices): 97 ids →
 * 5.3-5.9 ms, 577 ids → 22.3-23.1 ms, 1,000 ids → 14.3-14.5 ms. All of them are
 * two orders of magnitude under the 3,123-4,375 ms the pre-existing popularity
 * page-1 query costs.
 *
 * The cap keeps a caller-supplied `limit=100` from turning into a 2,401-id `IN`
 * list. That page comes back short (~81 rows) and says so by advancing its cursor;
 * a short page is a contract this endpoint already has.
 */
const chHydrateWidth = (limit: number) => Math.min(limit * 24 + 1, CH_HYDRATE_MAX);

const baseHandler = withAxiom(async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const claims = (req as BlockScopedNextApiRequest).blockClaims;
  if (!claims) {
    res.status(401).json({ error: 'Block token required' });
    return;
  }

  let subjectUserId: number | null;
  try {
    subjectUserId = parseSubjectUserId(claims.sub);
  } catch {
    res.status(403).json({ error: 'Invalid subject claim' });
    return;
  }
  if (subjectUserId == null) {
    res.status(403).json({ error: 'Anonymous block tokens may not read collections' });
    return;
  }

  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query parameters', details: parsed.error.flatten() });
    return;
  }
  const { mode, query, sort, period, cursor, limit } = parsed.data;

  // Does the requested period actually change anything? Four ways it does not, and
  // all four land on the untouched Postgres path:
  //   - absent               → the pre-existing behaviour, bit for bit
  //   - AllTime              → ClickHouse history starts 2025-11-06; PG owns all-time
  //   - mode=mine            → a period ranks DISCOVERY; "mine" is the viewer's own list
  //   - a non-popularity sort→ a period modifies popularity, not recency
  //
  // Written as a NARROWING ternary rather than a boolean so `windowedPeriod` carries
  // the `WindowedPeriod` type into the ranking call — a `boolean` here would force a
  // second, independently-written check at the call site, which is how the two
  // spellings of "windowed" drift apart.
  const windowedPeriod =
    mode === 'public' && sort === CollectionSort.MostContributors && isWindowedPeriod(period)
      ? period
      : null;

  // Per-instance rate limit (shared blocks catalog limiter) — bounds a block
  // hammering this private,no-store route onto the origin.
  const rateLimit = await checkBlockCatalogRateLimit(claims.blockInstanceId);
  if (!rateLimit.allowed) {
    res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
    res.status(429).json({ error: 'Rate limit exceeded, please retry shortly.' });
    return;
  }

  const regionRestricted = isRegionRestricted(getRegion(req));
  const { browsingLevel } = resolveCatalogBrowsingLevel(claims, { regionRestricted });

  const subjectUser = await hydrateBlockSubject(subjectUserId);
  if (!subjectUser) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  try {
    // ── PERIOD RESOLUTION ────────────────────────────────────────────────────
    // Resolved for BOTH modes in one place so `mode=mine` can report the same
    // "your period was ignored, here is what served you" answer as a non-popularity
    // sort, instead of silently dropping the parameter.
    //
    // `rankedIds === null` after this block means the request is served by the
    // PRE-EXISTING Postgres ordering — whether because no period was asked for, or
    // because ClickHouse could not answer. There is exactly one way to get a
    // ClickHouse-ordered page and it is `rankedIds` being non-null.
    let rankedIds: number[] | null = null;
    let source: 'clickhouse' | 'postgres' = 'postgres';
    let sourceReason: string | undefined;
    if (period) {
      if (windowedPeriod) {
        const ranking = await getWindowedCollectionRanking({ period: windowedPeriod });
        if (ranking.ids === null) {
          // 🔴 DEGRADE TO A STATED ORDERING, NEVER TO AN EMPTY GRID. `clickhouse` is
          // `undefined` in any deployment without CLICKHOUSE_HOST/USERNAME (and during
          // a Next build), and a live query can fail. Either way the viewer still gets
          // collections — ordered all-time — and the response carries the reason, so
          // "the popular-this-week tab looks like the all-time tab" is answerable from
          // the response body rather than only from a server log.
          sourceReason = ranking.reason;
        } else if (ranking.ids.length === 0) {
          // A window with no rows at all. Possible in principle; in practice far more
          // often the daily aggregate has not sealed yet than a real zero. Same
          // degrade, DIFFERENT reason, so the two stay separable.
          sourceReason = 'empty-window';
        } else {
          rankedIds = ranking.ids;
          source = 'clickhouse';
        }
      } else if (period === MetricTimeframe.AllTime) {
        sourceReason = 'all-time-served-from-postgres';
      } else if (mode !== 'public') {
        sourceReason = 'period-ignored-outside-public-discovery';
      } else {
        sourceReason = 'period-ignored-for-non-popularity-sort';
      }
    }

    // 🔴 EMITTED ONLY WHEN A `period` WAS SUPPLIED. This empty-object-spread is the
    // whole backward-compatibility mechanism: a caller that never sends `period`
    // gets a response with no `period`, `source` or `sourceReason` key — the same
    // body shape it got before this parameter existed. Giving `period` a default,
    // or emitting `source` unconditionally, would change every legacy response.
    const periodFields = period
      ? { period, source, ...(sourceReason ? { sourceReason } : {}) }
      : {};

    if (mode === 'public') {
      // Over-fetch so the maturity clamp can't under-fill the page and terminate
      // pagination early (which would make later public collections unreachable).
      // Walk the (createdAt DESC) rows collecting visible ones until the page is
      // full, then continue the keyset from the FIRST fetched row we did NOT
      // consume. getAllCollections' cursor is INCLUSIVE, so pointing next page's
      // cursor at that first-unconsumed row resumes exactly there — no gap (the
      // clamped-out rows before it were already walked past) and no duplicate (it
      // was not shown on this page).
      const OVERFETCH = overfetchWidth(limit);

      // On the ClickHouse path Postgres is no longer choosing the order — it is
      // HYDRATING AND FILTERING a slice of the ranked ids. One query either way,
      // the SAME privacy/type predicates either way; only the selection differs
      // (`ids` + no cursor, instead of a keyset walk).
      const chSlice = rankedIds
        ? rankedIds.slice(cursor ?? 0, (cursor ?? 0) + chHydrateWidth(limit))
        : null;

      // 🔴 AN EMPTY SLICE MUST NOT REACH `getAllCollections`. Its id clause is
      // `ids && ids.length > 0 ? { in: ids } : undefined` — so an empty array means
      // "no id filter at all", i.e. the entire public catalogue in createdAt order,
      // returned under a popularity feed's banner. Walking past the end of the
      // bounded leaderboard is an ordinary end-of-feed, so answer it as one.
      if (chSlice && chSlice.length === 0) {
        res.status(200).json({ items: [], ...periodFields });
        return;
      }

      const rows = await getAllCollections({
        input: {
          limit: chSlice ? chSlice.length : OVERFETCH,
          cursor: chSlice ? undefined : cursor,
          ids: chSlice ?? undefined,
          query,
          // 🔴 THE HYDRATE DELIBERATELY DOES NOT ASK FOR THE POPULARITY SORT ON
          // THE CLICKHOUSE PATH, AND THAT IS A COST DECISION, NOT A BEHAVIOUR ONE.
          // `CollectionSort.MostContributors` makes `getAllCollections` order by
          // `contributors._count`, i.e. a LEFT JOIN + GROUP BY over
          // `CollectionContributor` — the table with no index on `collectionId`,
          // and the exact join shape whose cost is the ~31x regression recorded on
          // `PLAYABLE_SAMPLE_SIZE`. Here that work would be pure waste: the rows
          // come back and are IMMEDIATELY re-projected onto the ClickHouse rank
          // order below, so whatever order Postgres chose is discarded. Asking for
          // the cheap `Newest` ordering buys the identical result set.
          sort: chSlice ? CollectionSort.Newest : sort,
          privacy: [CollectionReadConfiguration.Public],
          // MEDIA collections only — a Model/Article/Post collection renders an
          // empty player (the detail endpoint drops non-image items), so restrict
          // discovery to Image collections (which hold images + videos).
          types: [CollectionType.Image],
        },
        user: subjectUser,
        select: {
          id: true,
          name: true,
          description: true,
          read: true,
          nsfwLevel: true,
          userId: true,
          user: { select: { id: true, username: true } },
          image: { select: { url: true, type: true, nsfwLevel: true } },
        },
      });

      // The playable-fraction floor decides which rows the walk below consumes, so
      // it has to be resolved BEFORE the walk, over every row that could still
      // appear — not after the page is chosen. Only rows that already clear the
      // collection-level ceiling can appear, so those are the only ids worth
      // sampling.
      //
      // 🔴 SAMPLED, NOT COUNTED, AND THAT IS THE WHOLE COST STORY. Computing the
      // EXACT clamped count over this over-fetch window costs ~2.6-2.8 s against
      // the ~85 ms this endpoint takes without it — a ~31× regression on the
      // discovery front door — because the clamp's join to "Image" forfeits the
      // covering index the unclamped count scans. Narrowing OVERFETCH does not
      // rescue it (~27%). One bounded, order-pinned LATERAL sample costs ~400 ms
      // as shipped and agreed with the exact count on this floor for 97 of 97 live
      // collections. Measurements, the order-sensitivity that forces the ORDER BY,
      // and why that pin costs ~4x an unordered LIMIT are on
      // `PLAYABLE_SAMPLE_SIZE` — including the retraction of an earlier 257 ms
      // figure that had been measured WITHOUT the ordering.
      const ceilingOk = (c: (typeof rows)[number]) =>
        collectionWithinCeiling(c.nsfwLevel ?? 0, browsingLevel);
      const candidateIds = rows.filter(ceilingOk).map((c) => c.id);
      const playableSample = await getCollectionPlayableSample(candidateIds, browsingLevel);

      const items: typeof rows = [];
      let nextCursor: number | undefined;

      if (chSlice) {
        // ── ClickHouse-ranked page ───────────────────────────────────────────
        // 🔴 WALK THE RANKED ID LIST, NOT THE HYDRATED ROWS. `rows` came back in
        // Postgres' own order and is MISSING every id the privacy/type predicates
        // rejected. Iterating `rows` would therefore serve a "popular this week"
        // feed sorted by createdAt, and would advance the offset by the number of
        // SURVIVING rows rather than the number of ranked ids consumed — so a
        // heavily-filtered page would re-serve the same ids forever.
        const byId = new Map(rows.map((c) => [c.id, c] as const));
        const offset = cursor ?? 0;
        let walked = 0;
        for (let i = 0; i < chSlice.length; i++) {
          if (items.length >= limit) break;
          walked = i + 1;
          const c = byId.get(chSlice[i]);
          // 🔴 THIS IS THE PRIVACY AND TYPE GATE, AND IT IS AN ABSENCE RATHER THAN
          // A TEST. ClickHouse ranks ids with no idea what they are; the hydrate
          // above asked for `privacy: [Public]` + `types: [Image]` over exactly
          // these ids, so a private collection or a Model/Article/Post collection
          // simply has no row and arrives here as `undefined`. Do not "improve"
          // this into reading `c.read` / `c.type` — the check that matters already
          // happened in the database, and a missing row is the only correct
          // interpretation of a rejected id. A deleted collection lands here too.
          if (!c) continue;
          if (!ceilingOk(c)) continue;
          const sample = playableSample.get(c.id);
          if (!meetsPlayableFloor(sample?.sampled ?? 0, sample?.playable ?? 0)) continue;
          items.push(c);
        }
        // FILTERING SHRINKS THE SET, so this page can come back short — the same
        // trade the Postgres walk makes below. What keeps the feed alive is that
        // the cursor advances by every ranked id WALKED (rejects included), not by
        // the rows shown, so the next page starts past them. Exhausting the bounded
        // leaderboard emits no cursor, which ends the windowed feed by design.
        const consumedTo = offset + walked;
        if (consumedTo < (rankedIds?.length ?? 0)) nextCursor = consumedTo;
      } else {
        let firstUnconsumedId: number | undefined;
        for (let i = 0; i < rows.length; i++) {
          if (items.length >= limit) {
            firstUnconsumedId = rows[i].id;
            break;
          }
          if (!ceilingOk(rows[i])) continue;
          // 🔴 THE DROP, AND WHY IT IS INSIDE THIS WALK RATHER THAN AFTER IT. The
          // sample map is absent-means-nothing-sampled (the lateral emits no row for
          // a collection with no accepted items), which `meetsPlayableFloor` reads as
          // "nothing to judge, keep". Filtering here means a dropped row is walked
          // PAST like a clamped-out one, so the page still fills to `limit` and
          // `firstUnconsumedId` still advances — filtering the sliced page afterwards
          // would return short pages and, on a page that filtered to empty, emit no
          // cursor at all and TERMINATE the feed while qualifying collections
          // remained.
          const sample = playableSample.get(rows[i].id);
          if (!meetsPlayableFloor(sample?.sampled ?? 0, sample?.playable ?? 0)) continue;
          items.push(rows[i]);
        }

        if (firstUnconsumedId !== undefined) {
          // Page filled AND at least one fetched row remains → clean inclusive resume.
          nextCursor = firstUnconsumedId;
        } else if (rows.length === OVERFETCH) {
          // Consumed the ENTIRE over-fetch without filling `limit` (a very heavy
          // clamp) yet the source returned a full batch → more may remain. Resume
          // from the last fetched row (inclusive → re-fetched next page; the client
          // dedups by id). No longer rare: the playable floor drops far more rows
          // than the ceiling alone did, so a page CAN come back short — but it comes
          // back with a cursor that advanced by OVERFETCH-1 rows, which is what
          // keeps the rest of the feed reachable. Short page, live feed.
          nextCursor = rows[rows.length - 1]?.id;
        }
        // else: rows.length < OVERFETCH and the page wasn't over-consumed → the
        // source is exhausted → no nextCursor.
      }

      const ids = items.map((c) => c.id);
      // Cover fallback + MATURITY CLAMP: a cover is usable only when it exists AND
      // its own nsfwLevel is within the token's clamped ceiling. A MIXED-bucket
      // collection can pass the collection-level discovery gate (bitwise) yet have
      // a mature cover / first item, so an unclamped cover would leak mature media
      // on a SFW-domain / region-restricted token. When the primary cover is null
      // OR over the ceiling, fall back to the newest CLAMPED item (same authority
      // the detail path uses).
      const primaryCoverUsable = (c: (typeof items)[number]) =>
        !!c.image?.url && collectionWithinCeiling(c.image.nsfwLevel ?? 0, browsingLevel);
      const missingCoverIds = items.filter((c) => !primaryCoverUsable(c)).map((c) => c.id);
      const [countRows, followed, fallbackCovers] = await Promise.all([
        // 🔴 THE ADVERTISED (UNCLAMPED) COUNT — the same query, over the same
        // `limit`-sized id list, that this endpoint has always run. It is not a
        // lie: it is the collection's real size, and the floor above now
        // guarantees most of it is playable. It is deliberately NOT the sampled
        // fraction extrapolated to a total — `itemCount` reads as an exact number
        // and must not carry an estimate — and it is deliberately not the exact
        // clamped count, which is the ~31× regression this design exists to avoid.
        getCollectionItemCount({ collectionIds: ids, status: CollectionItemStatus.ACCEPTED }),
        getFollowedCollectionIds(subjectUserId, ids),
        getFallbackCoverImages(missingCoverIds, browsingLevel),
      ]);
      const countMap = new Map(countRows.map((c) => [c.id, Number(c.count)]));

      res.status(200).json({
        items: items.map((c) => ({
          id: c.id,
          name: c.name,
          description: c.description ?? null,
          // ONE image in, BOTH cover fields out — the url and the level of that
          // same image. Splitting these back into two expressions is how a
          // fallback cover ends up advertising the primary's level.
          ...toCoverFields(primaryCoverUsable(c) ? c.image : fallbackCovers.get(c.id)),
          itemCount: countMap.get(c.id) ?? 0,
          curator: { userId: c.userId, username: c.user?.username ?? null },
          isPublic: c.read === CollectionReadConfiguration.Public,
          followed: followed.has(c.id),
        })),
        nextCursor,
        ...periodFields,
      });
      return;
    }

    // mode === 'mine' — the subject's own collections. The service returns the
    // FULL owned+contributed set (no DB pagination), so we apply the name filter +
    // keyset (id DESC) slice in-memory. A user's own collection set is bounded.
    //
    // READ SPLIT: own PUBLIC collections are always returned (collections:read:self
    // gated the endpoint). Own NON-PUBLIC collections (Private/Unlisted — anything
    // not `Public`) are included ONLY when the token ALSO carries the consent-gated
    // `collections:read:private` scope; otherwise they are omitted entirely.
    const canReadPrivate = claims.scopes.includes('collections:read:private');
    const owned = await getUserCollectionsWithPermissions({
      input: { userId: subjectUserId, contributingOnly: true },
    });

    const needle = query?.toLowerCase();
    const filtered = owned
      .filter((c) => (needle ? c.name.toLowerCase().includes(needle) : true))
      // Read split: hide non-public own collections unless read:private is granted.
      .filter((c) => canReadPrivate || c.read === CollectionReadConfiguration.Public)
      .filter((c) => (cursor ? c.id < cursor : true))
      .sort((a, b) => b.id - a.id);

    let items = filtered;
    let nextCursor: number | undefined;
    if (items.length > limit) {
      items = items.slice(0, limit);
      nextCursor = items[items.length - 1]?.id;
    }

    const ids = items.map((c) => c.id);
    // Same maturity clamp as public discovery: a primary cover over the ceiling
    // (or null) falls back to the newest CLAMPED item so a SFW-domain / region-
    // restricted token never gets a mature thumbnail — even for own collections.
    const primaryCoverUsable = (c: (typeof items)[number]) =>
      !!c.image?.url && collectionWithinCeiling(c.image.nsfwLevel ?? 0, browsingLevel);
    const missingCoverIds = items.filter((c) => !primaryCoverUsable(c)).map((c) => c.id);
    const [countRows, followed, fallbackCovers] = await Promise.all([
      // 🔴 THE EXACT CLAMPED COUNT, WHICH THIS BRANCH CAN AFFORD AND PUBLIC
      // DISCOVERY CANNOT. `itemCount` here is the number the player will serve, so
      // a viewer's own card never promises items their ceiling hides. The reason
      // the same choice is impossible on the public branch is not the query — it
      // is the POPULATION. This branch counts only the subject's own collections:
      // a bounded set, already sliced to `limit`, with no over-fetch window and no
      // 34,577-item contest collection dragged in by a popularity sort. Public
      // discovery counts up to `limit * 4 + 1` candidates chosen precisely because
      // the sort ranks the biggest ones first, which is what turns the same clamp
      // into a ~2.6 s query (see `PLAYABLE_SAMPLE_SIZE`).
      //
      // 🔴 AND NO PLAYABLE-FRACTION FLOOR ON THIS BRANCH, DELIBERATELY. These are
      // the SUBJECT'S OWN collections: they created or bookmarked every one of
      // them and know it is in this list. Dropping one for being mostly mature
      // makes it look deleted, which is the defect class the detail surface
      // already settled the other way — an empty own-collection is shown DISABLED
      // WITH A REASON, never hidden. The floor is a DISCOVERY ranking filter, and
      // there is nothing to discover in a list the viewer assembled.
      getCollectionItemCount({
        collectionIds: ids,
        status: CollectionItemStatus.ACCEPTED,
        browsingLevel,
      }),
      getFollowedCollectionIds(subjectUserId, ids),
      getFallbackCoverImages(missingCoverIds, browsingLevel),
    ]);
    const countMap = new Map(countRows.map((c) => [c.id, Number(c.count)]));

    res.status(200).json({
      items: items.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description ?? null,
        // Same single-image projection as public discovery — see the note there.
        ...toCoverFields(primaryCoverUsable(c) ? c.image : fallbackCovers.get(c.id)),
        itemCount: countMap.get(c.id) ?? 0,
        curator: { userId: c.userId, username: subjectUser.username ?? null },
        isPublic: c.read === CollectionReadConfiguration.Public,
        followed: followed.has(c.id),
      })),
      nextCursor,
      ...periodFields,
    });
    return;
  } catch (error) {
    res.status(500).json({ error: 'Failed to load collections' });
    return;
  }
});

// Scope-gated: collections:read:self (self-scope → non-anon subject enforced by
// the middleware). Not the "any valid token" catalog mode — reads are subject-
// bound (own private collections), so a declared+granted scope is the gate.
// allowOpaqueOrigin: an UNVERIFIED block direct-fetches this from an opaque
// origin (`Origin: null`), so it needs `ACAO: null` to clear the CORS preflight;
// the Bearer block-JWT (no cookies) remains the sole authz gate — mirrors
// images.ts; see WithBlockScopeOpts.allowOpaqueOrigin.
export default withBlockScope(baseHandler, {
  endpoint: 'collections',
  requiredScope: 'collections:read:self',
  allowOpaqueOrigin: true,
});
