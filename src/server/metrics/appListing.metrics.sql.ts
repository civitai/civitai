// ---------------------------------------------------------------------------
// App Store Listings (W13) — pure SQL + aggregate spec for AppListingMetric.
//
// Dependency-free on purpose: the processor (appListing.metrics.ts) imports the
// heavy metric framework (redis / clickhouse / db clients), so the SQL strings +
// the executable spec live here so they can be unit-tested WITHOUT booting any
// of that. See appListing.metrics.ts for the full ownership/sourcing rationale.
//
// SCOPE: this job populates `install_count` (from Postgres) and `open_count`
// (from the ClickHouse `App_Open` event stream) — the two AppListingMetric
// counters with a reader. Every remaining counter (`connect_count`,
// `visit_count`, `tipped_count`, `tipped_amount_count`) is left at its schema
// default 0: none is read, and each maps to a feature that isn't live yet
// (OAuth-connect submission is a locked-deferred product decision; visit/tip have
// no server-side source). Populate each with the PR that ships its consumer, not
// speculatively.
// ---------------------------------------------------------------------------

/**
 * The ClickHouse `actions.type` value the run-page SSR resolver emits per on-site
 * app launch. Deliberately a bare string rather than an import from the tracker's
 * `ActionType` union: this module is dependency-free by design, and the rollup
 * must keep working (returning 0) on a deploy where the emitter is absent.
 */
export const APP_OPEN_ACTION_TYPE = 'App_Open';

/**
 * Approved listings whose metrics may have changed since `$1` (= ctx.lastUpdate),
 * UNION approved listings with no metric row yet (seed a real 0-row so the
 * `popular` sort orders them correctly instead of NULL-first).
 *
 * $1 :: timestamptz — the incremental watermark.
 * $2 :: text[]      — app_block_ids ClickHouse reports as having had an `App_Open`
 *                     event since the watermark. Without this arm a listing whose
 *                     ONLY change is new plays would never be recomputed: nothing
 *                     in Postgres moves when a play happens.
 *
 * Returns `app_block_id` alongside the id so the caller can ask ClickHouse for
 * those blocks' play counts without a second Postgres round trip.
 *
 * NOTE (delete-blindness): a HARD-deleted source row (a hard uninstall that
 * DELETEs a BlockUserSubscription) has no create/update timestamp after it's
 * gone, so it can't be caught by "changed since lastUpdate". The common path is
 * covered — a toggle-off flips `enabled=false` and bumps `updated_at`, so it IS
 * caught. For a tiny dark cohort this residual staleness is acceptable; a
 * periodic full recompute could close it later. `open_count` does NOT have this
 * problem: its source rows are append-only ClickHouse events and the count is a
 * full recompute over all of them, never a delta.
 */
export const AFFECTED_APPROVED_LISTINGS_SQL = `
  SELECT al.id, al."app_block_id"
  FROM "app_listings" al
  WHERE al."status" = 'approved'
    AND (
      -- Seed: no metric row yet (the upsert computes the REAL count, not just 0).
      NOT EXISTS (
        SELECT 1 FROM "app_listing_metrics" m WHERE m."app_listing_id" = al.id
      )
      -- On-site install source changed.
      OR (
        al."kind" = 'onsite' AND al."app_block_id" IS NOT NULL AND EXISTS (
          SELECT 1 FROM "block_user_subscriptions" bus
          WHERE bus."app_block_id" = al."app_block_id"
            AND (bus."created_at" > $1 OR bus."updated_at" > $1)
        )
      )
      -- New plays since the watermark (discovered in ClickHouse, not Postgres).
      OR (
        al."kind" = 'onsite' AND al."app_block_id" = ANY($2::text[])
      )
    )
`;

/**
 * Recompute install_count + open_count for a batch of listing ids and upsert into
 * app_listing_metrics.
 *
 * $1 :: text[] — the listing ids.
 * $2 :: text[] — app_block_ids, parallel to $3.
 * $3 :: int[]  — the ALL-TIME deduped play count for each app_block_id in $2.
 *
 * 🔴 $2/$3 MUST COVER EVERY on-site listing in $1, including the ones with zero
 * plays. `open_count` is DERIVED — a full recompute, never a `+1` — so a listing
 * missing from the map is written as 0, not left alone. Feeding a partial map
 * (e.g. only the blocks with events since the watermark) would zero the count of
 * every listing recomputed for an unrelated reason. The caller therefore queries
 * ClickHouse for the whole affected set, not just the recently-active part.
 *
 * install_count is computed LIVE from Postgres (not derived from the
 * affected-query), so even a freshly-seeded row (or a row created by the thumbs
 * writer with install=0) gets its true current count. Scoped to approved listings.
 *
 * 🔴 The INSERT column list AND the ON CONFLICT DO UPDATE set name ONLY
 * install_count / open_count / updated_at. thumbs_up_count / thumbs_down_count are
 * NEVER touched (ownership contract with app-listing-review.service.ts);
 * connect/visit/tipped stay at their schema default 0 (see the SCOPE note above).
 * Do not add any of them here without a reader to justify it.
 */
export const APP_LISTING_METRIC_UPSERT_SQL = `
  INSERT INTO "app_listing_metrics" (
    "app_listing_id",
    "install_count",
    "open_count",
    "updated_at"
  )
  SELECT
    al.id,
    CASE
      WHEN al."kind" = 'onsite' AND al."app_block_id" IS NOT NULL THEN (
        SELECT COUNT(*)::int
        FROM "block_user_subscriptions" bus
        WHERE bus."app_block_id" = al."app_block_id"
          AND bus."enabled" = TRUE
      )
      ELSE 0
    END AS install_count,
    CASE
      WHEN al."kind" = 'onsite' AND al."app_block_id" IS NOT NULL
        THEN COALESCE(oc."open_count", 0)
      ELSE 0
    END AS open_count,
    NOW() AS updated_at
  FROM "app_listings" al
  LEFT JOIN unnest($2::text[], $3::int[]) AS oc("app_block_id", "open_count")
    ON oc."app_block_id" = al."app_block_id"
  WHERE al.id = ANY($1::text[])
    AND al."status" = 'approved'
  ON CONFLICT ("app_listing_id") DO UPDATE
    SET
      "install_count" = EXCLUDED."install_count",
      "open_count" = EXCLUDED."open_count",
      "updated_at" = NOW()
`;

// ---------------------------------------------------------------------------
// ClickHouse side — the `App_Open` event stream.
//
// 🔴 WHY `toString(type) = 'App_Open'` AND NOT `type = 'App_Open'`.
// `actions.type` is an Enum16. Comparing an Enum column to a literal the enum
// does not carry is a QUERY ERROR in ClickHouse ("Unknown element ... for enum"),
// not an empty result — so the plain form would make this metric processor throw
// on every run, taking `install_count` down with it, on any deploy where the
// widening migration has not been applied yet. `toString(type)` compares the
// rendered name and simply matches nothing, which is exactly the inert behaviour
// this rollup wants until the migration lands.
//
// 🔴 WHY `PREWHERE`. The count query below is deliberately UNBOUNDED IN TIME (an
// all-time figure — AppListingMetric has no timeframe column), and `actions` is a
// large table ordered by (time, type), so nothing prunes. PREWHERE reads the
// narrow `type` column first and only then reads `details`/`userId`/`ip`/`time`
// for the surviving rows. Do not move that predicate into the WHERE clause.
// ---------------------------------------------------------------------------

/**
 * Escape a value for a single-quoted ClickHouse string literal.
 *
 * These ids come from Postgres (`apb_<ULID>`), so in practice nothing needs
 * escaping — but `ctx.ch.$query`'s template interpolation does NOT quote or escape
 * string values, so building an `IN (...)` list by hand without this would be an
 * injection surface the moment an id shape changes. Escaping (rather than
 * rejecting) is deliberate: rejecting an id would drop it from the count map, and
 * a missing entry is written as a 0 — silent data loss instead of a wrong query.
 */
export function escapeClickhouseString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * app_block_ids with at least one `App_Open` event since `sinceIso`.
 *
 * This is the affected-set discovery half: Postgres cannot see a play (no row of
 * its own moves), so ClickHouse is asked which apps were opened and those app
 * blocks are fed into `AFFECTED_APPROVED_LISTINGS_SQL` as `$2`. Mirrors the
 * ClickHouse-first pattern in model3d.metrics.ts (`getDownloadTasks`).
 *
 * `sinceIso` is an ISO-8601 instant; the caller passes `ctx.lastUpdate`, which
 * base.metrics has already widened by 2 minutes to let the tracker catch up.
 */
export function buildAppOpenRecentBlockIdsSql(sinceIso: string): string {
  return `
    SELECT DISTINCT JSONExtractString(details, 'appBlockId') AS appBlockId
    FROM actions
    PREWHERE toString(type) = '${APP_OPEN_ACTION_TYPE}'
    WHERE time >= parseDateTimeBestEffort('${escapeClickhouseString(sinceIso)}')
      AND JSONExtractString(details, 'appBlockId') != ''
  `;
}

/**
 * ALL-TIME deduped play count per app_block_id.
 *
 * ── THE SEMANTICS, IN PLAIN ENGLISH ─────────────────────────────────────────
 * One play = ONE DISTINCT ACTOR PER APP PER UTC DAY. An actor is the signed-in
 * `userId` when there is one, and the request `ip` when there is not. `open_count`
 * is the sum of those per-day distinct counts over ALL TIME.
 *
 * So: reloading an app twenty times this afternoon is 1. Opening it again tomorrow
 * is 2. Two different signed-in users today is 2. Two signed-out visitors on
 * different IPs today is 2. A signed-in user and a signed-out visitor are always
 * two different actors — `userId` 0 is the tracker's "anonymous" sentinel, so it is
 * never used as an identity; those rows fall back to `ip`.
 *
 * 🔴 STAGE 4 PUTS A PUBLIC LABEL NEXT TO THIS NUMBER. It is closer to "people who
 * opened this" than to "times opened", and it is a LOWER bound on both: every
 * signed-out visitor behind one NAT egress IP collapses to a single daily actor,
 * and the tracker's `ip` fallback is the literal string `unknown` when the client
 * IP cannot be resolved, which collapses all such requests for a day into one.
 * Undercounting is the deliberate direction — the emit is an unauthenticated,
 * unrated-limited GET on an optional catch-all route, so the raw row count is
 * inflatable by a refresh loop, a crawler or a chat-client link unfurler, and an
 * inflated public number is worse than a conservative one.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Returns no row for an app block with no events; the caller must treat a missing
 * entry as 0 (which is what the upsert's COALESCE does).
 */
export function buildAppOpenCountSql(appBlockIds: string[]): string {
  const inList = appBlockIds.map((id) => `'${escapeClickhouseString(id)}'`).join(', ');
  return `
    SELECT appBlockId, sum(dailyActors) AS openCount
    FROM (
      SELECT
        JSONExtractString(details, 'appBlockId') AS appBlockId,
        toDate(time, 'UTC') AS day,
        uniqExact(if(userId != 0, concat('u:', toString(userId)), concat('i:', ip))) AS dailyActors
      FROM actions
      PREWHERE toString(type) = '${APP_OPEN_ACTION_TYPE}'
      WHERE JSONExtractString(details, 'appBlockId') IN (${inList})
      GROUP BY appBlockId, day
    )
    GROUP BY appBlockId
  `;
}

// ---------------------------------------------------------------------------
// Executable spec of the aggregate semantics (mirrors the SQL above).
//
// The SQL is the production path (install_count in Postgres, open_count in
// ClickHouse); this pure function encodes the SAME rules over in-memory rows so
// the invariants — approved-only, on-site-only, ACTIVE (enabled) install
// filtering, the one-actor-per-UTC-day play dedup, and NEVER emitting thumbs —
// are unit-testable without a database. Keep it in lockstep with the SQL above:
// they are a matched pair, and changing one without the other is precisely the
// drift the pair exists to prevent.
// ---------------------------------------------------------------------------

/** One raw ClickHouse `actions` row of type `App_Open`, as the rollup reads it. */
export type AppOpenEvent = {
  appBlockId: string;
  /** The tracker's actor `userId`; **0 means anonymous**, never "user zero". */
  userId: number;
  /** The tracker's actor `ip`; the literal `'unknown'` when unresolvable. */
  ip: string;
  time: Date | string;
};

export type AppListingComputeInput = {
  listings: Array<{
    id: string;
    kind: 'onsite' | 'offsite';
    status: string;
    appBlockId: string | null;
  }>;
  /** BlockUserSubscription rows. `enabled=false` = toggled-off (not an active install). */
  subscriptions: Array<{ appBlockId: string; enabled: boolean }>;
  /** `App_Open` rows. Required, not optional — an omitted stream must not read as "no plays". */
  openEvents: AppOpenEvent[];
};

export type AppListingMetricUpdate = {
  appListingId: string;
  installCount: number;
  openCount: number;
};

/**
 * The dedup identity of one play. Mirrors
 * `if(userId != 0, concat('u:', toString(userId)), concat('i:', ip))`.
 *
 * The prefixes matter: without them a signed-in user id could collide with an ip
 * string, and `userId` 0 must never be an identity of its own — it is the
 * tracker's anonymous sentinel, so every anonymous request would otherwise
 * collapse into ONE actor site-wide.
 */
export function appOpenActorKey(event: Pick<AppOpenEvent, 'userId' | 'ip'>): string {
  return event.userId !== 0 ? `u:${event.userId}` : `i:${event.ip}`;
}

/** The UTC calendar day of a play. Mirrors `toDate(time, 'UTC')`. */
export function appOpenUtcDay(time: Date | string): string {
  return new Date(time).toISOString().slice(0, 10);
}

/**
 * ALL-TIME deduped play count per app_block_id — the in-memory mirror of
 * `buildAppOpenCountSql`. Exported so the dedup rule can be exercised directly.
 */
export function computeAppOpenCounts(events: AppOpenEvent[]): Map<string, number> {
  // appBlockId -> utcDay -> set of actor keys
  const byBlock = new Map<string, Map<string, Set<string>>>();
  for (const event of events) {
    // Mirrors the SQL's `JSONExtractString(details, 'appBlockId') != ''` filter:
    // a row whose details carried no appBlockId joins to nothing.
    if (!event.appBlockId) continue;
    let byDay = byBlock.get(event.appBlockId);
    if (!byDay) {
      byDay = new Map<string, Set<string>>();
      byBlock.set(event.appBlockId, byDay);
    }
    const day = appOpenUtcDay(event.time);
    let actors = byDay.get(day);
    if (!actors) {
      actors = new Set<string>();
      byDay.set(day, actors);
    }
    actors.add(appOpenActorKey(event));
  }

  const counts = new Map<string, number>();
  for (const [appBlockId, byDay] of byBlock) {
    let total = 0;
    for (const actors of byDay.values()) total += actors.size;
    counts.set(appBlockId, total);
  }
  return counts;
}

export function computeAppListingMetricUpdates(
  input: AppListingComputeInput
): AppListingMetricUpdate[] {
  const openCounts = computeAppOpenCounts(input.openEvents);

  return input.listings
    .filter((l) => l.status === 'approved')
    .map((l) => {
      // Both counters are on-site-only, and for the same structural reason: the
      // join key IS `app_block_id`, which off-site listings do not have. An
      // off-site listing's CTA is a third-party anchor, so no on-platform request
      // follows the click and there is nothing trustworthy to count.
      //
      // 🔴 A 0 HERE MEANS "no plays OR not measurable" — the two are not
      // distinguishable in this column. Stage 3 must therefore project `openCount`
      // as `null` for `kind='offsite'` rather than 0: an off-site card omits the
      // stat entirely instead of showing a zero that reads as "nobody used it".
      //
      // Of the two conjuncts only `kind === 'onsite'` is load-bearing here: with a
      // null `appBlockId` both lookups below miss anyway (no subscription row has a
      // null app_block_id, and `Map.get(null)` is undefined), so the `!!l.appBlockId`
      // half is REDUNDANT BY CONSTRUCTION — measured, mutating it away leaves the
      // whole suite green. It is kept for intent and to mirror the SQL's
      // `IS NOT NULL`, not as a behavioural guard; do not read it as one.
      const measurable = l.kind === 'onsite' && !!l.appBlockId;
      return {
        appListingId: l.id,
        installCount: measurable
          ? input.subscriptions.filter((s) => s.appBlockId === l.appBlockId && s.enabled).length
          : 0,
        openCount: measurable ? openCounts.get(l.appBlockId as string) ?? 0 : 0,
      };
    });
}
