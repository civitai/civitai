// ---------------------------------------------------------------------------
// App Store Listings (W13) — pure SQL + aggregate spec for AppListingMetric.
//
// Dependency-free on purpose: the processor (appListing.metrics.ts) imports the
// heavy metric framework (redis / clickhouse / db clients), so the SQL strings +
// the executable spec live here so they can be unit-tested WITHOUT booting any
// of that. See appListing.metrics.ts for the full ownership/sourcing rationale.
//
// SCOPE: this job populates ONLY `install_count` — the single AppListingMetric
// counter the read path actually consumes (the store `popular` sort =
// `install_count DESC`, and the `top-rated` Bayesian tiebreak). Every other
// counter (`connect_count`, `open_count`, `visit_count`, `tipped_count`,
// `tipped_amount_count`) is left at its schema default 0: none is read today, and
// each maps to a feature that isn't live yet (OAuth-connect submission is a
// locked-deferred product decision; open/visit/tip have no server-side source
// table). Populate each with the PR that ships its consumer, not speculatively.
// ---------------------------------------------------------------------------

/**
 * Approved listings whose install source changed since `$1` (= ctx.lastUpdate),
 * UNION approved listings with no metric row yet (seed a real 0-row so the
 * `popular` sort orders them correctly instead of NULL-first).
 *
 * $1 :: timestamptz — the incremental watermark.
 *
 * NOTE (delete-blindness): a HARD-deleted source row (a hard uninstall that
 * DELETEs a BlockUserSubscription) has no create/update timestamp after it's
 * gone, so it can't be caught by "changed since lastUpdate". The common path is
 * covered — a toggle-off flips `enabled=false` and bumps `updated_at`, so it IS
 * caught. For a tiny dark cohort this residual staleness is acceptable; a
 * periodic full recompute could close it later.
 */
export const AFFECTED_APPROVED_LISTINGS_SQL = `
  SELECT al.id
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
    )
`;

/**
 * Recompute install_count for a batch of listing ids and upsert into
 * app_listing_metrics. $1 :: text[] — the listing ids.
 *
 * The count is computed LIVE (not derived from the affected-query), so even a
 * freshly-seeded row (or a row created by the thumbs writer with install=0) gets
 * its true current count. Scoped to approved listings only.
 *
 * 🔴 The INSERT column list AND the ON CONFLICT DO UPDATE set name ONLY
 * install_count / updated_at. thumbs_up_count / thumbs_down_count are NEVER
 * touched (ownership contract with app-listing-review.service.ts); connect/open/
 * visit/tipped stay at their schema default 0 (see the SCOPE note above). Do not
 * add any of them here without a reader to justify it.
 */
export const APP_LISTING_METRIC_UPSERT_SQL = `
  INSERT INTO "app_listing_metrics" (
    "app_listing_id",
    "install_count",
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
    NOW() AS updated_at
  FROM "app_listings" al
  WHERE al.id = ANY($1::text[])
    AND al."status" = 'approved'
  ON CONFLICT ("app_listing_id") DO UPDATE
    SET
      "install_count" = EXCLUDED."install_count",
      "updated_at" = NOW()
`;

// ---------------------------------------------------------------------------
// Executable spec of the aggregate semantics (mirrors the SQL above).
//
// The SQL is the production path (it runs in Postgres); this pure function
// encodes the SAME rules over in-memory rows so the invariants — approved-only,
// on-site-only installs, ACTIVE (enabled) install filtering, and NEVER emitting
// thumbs — are unit-testable without a database. Keep it in lockstep with the
// SQL above.
// ---------------------------------------------------------------------------
export type AppListingComputeInput = {
  listings: Array<{
    id: string;
    kind: 'onsite' | 'offsite';
    status: string;
    appBlockId: string | null;
  }>;
  /** BlockUserSubscription rows. `enabled=false` = toggled-off (not an active install). */
  subscriptions: Array<{ appBlockId: string; enabled: boolean }>;
};

export type AppListingMetricUpdate = {
  appListingId: string;
  installCount: number;
};

export function computeAppListingMetricUpdates(
  input: AppListingComputeInput
): AppListingMetricUpdate[] {
  return input.listings
    .filter((l) => l.status === 'approved')
    .map((l) => ({
      appListingId: l.id,
      installCount:
        l.kind === 'onsite' && l.appBlockId
          ? input.subscriptions.filter((s) => s.appBlockId === l.appBlockId && s.enabled).length
          : 0,
    }));
}
