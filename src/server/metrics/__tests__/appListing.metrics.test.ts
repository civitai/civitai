import { describe, expect, it } from 'vitest';

import {
  AFFECTED_APPROVED_LISTINGS_SQL,
  APP_LISTING_BATCH_SIZE,
  APP_LISTING_METRIC_UPSERT_SQL,
  APP_OPEN_ACTION_TYPE,
  APP_OPEN_CH_CHUNK_SIZE,
  APP_OPEN_COUNT_QUERY_MARKER,
  appOpenActorKey,
  appOpenUtcDay,
  buildAppOpenCountSql,
  buildAppOpenRecentBlockIdsSql,
  computeAppListingMetricUpdates,
  computeAppOpenCounts,
  escapeClickhouseString,
  fetchAppOpenCounts,
  fetchRecentlyOpenedBlockIds,
  selectAffectedApprovedListings,
  type AffectedListingsInput,
  type AppListingComputeInput,
  type AppOpenCountRow,
  type AppOpenEvent,
} from '~/server/metrics/appListing.metrics.sql';

/**
 * W13 — AppListingMetric install + open (PLAY) ROLLUP job.
 *
 * The SQL runs in Postgres (installs) and ClickHouse (plays);
 * `computeAppListingMetricUpdates` is the executable spec that mirrors both, so
 * the aggregate invariants are testable without either. The later blocks assert
 * invariants directly against the production SQL strings — the thumbs-ownership
 * contract and the spec⇄SQL lockstep are enforced structurally there.
 */

const base = (over: Partial<AppListingComputeInput['listings'][number]>) => ({
  id: 'apl_1',
  kind: 'onsite' as const,
  status: 'approved',
  appBlockId: null,
  ...over,
});

/**
 * A play. Defaults are deliberately NOT the sentinel values the rules key on:
 * `userId` is non-zero and `ip` is a real address, so a test that means to
 * exercise the anonymous path has to say so.
 */
const play = (over: Partial<AppOpenEvent> = {}): AppOpenEvent => ({
  appBlockId: 'apb_alpha',
  userId: 71,
  ip: '203.0.113.7',
  time: '2026-09-05T10:00:00.000Z',
  ...over,
});

describe('computeAppListingMetricUpdates — install aggregate spec', () => {
  it('on-site approved listing → installCount = its ACTIVE (enabled) subscription count', () => {
    const input: AppListingComputeInput = {
      listings: [base({ id: 'apl_onsite', kind: 'onsite', appBlockId: 'ab_1' })],
      subscriptions: [
        { appBlockId: 'ab_1', enabled: true },
        { appBlockId: 'ab_1', enabled: true },
        { appBlockId: 'ab_1', enabled: true },
        { appBlockId: 'ab_1', enabled: false }, // toggled-off → NOT an active install
        { appBlockId: 'ab_other', enabled: true }, // different app → excluded
      ],
      openEvents: [],
    };

    expect(computeAppListingMetricUpdates(input)).toEqual([
      { appListingId: 'apl_onsite', installCount: 3, openCount: 0 },
    ]);
  });

  it('off-site listing → installCount 0 (installs are on-site only)', () => {
    const input: AppListingComputeInput = {
      listings: [base({ id: 'apl_offsite', kind: 'offsite' })],
      // Even if a subscription somehow matched, an off-site listing must never
      // count installs — the CASE gates on kind='onsite'.
      subscriptions: [{ appBlockId: 'ab_1', enabled: true }],
      openEvents: [],
    };

    const [row] = computeAppListingMetricUpdates(input);
    expect(row.installCount).toBe(0);
  });

  it('on-site listing with a null app_block_id → installCount 0', () => {
    const input: AppListingComputeInput = {
      listings: [base({ id: 'apl_noblock', kind: 'onsite', appBlockId: null })],
      subscriptions: [{ appBlockId: 'ab_1', enabled: true }],
      openEvents: [],
    };

    expect(computeAppListingMetricUpdates(input)).toEqual([
      { appListingId: 'apl_noblock', installCount: 0, openCount: 0 },
    ]);
  });

  it('non-approved listings (draft / pending / rejected / removed) are excluded', () => {
    const input: AppListingComputeInput = {
      listings: [
        base({ id: 'apl_draft', status: 'draft', appBlockId: 'ab_1' }),
        base({ id: 'apl_pending', status: 'pending', appBlockId: 'ab_1' }),
        base({ id: 'apl_rejected', status: 'rejected', appBlockId: 'ab_1' }),
        base({ id: 'apl_removed', status: 'removed', appBlockId: 'ab_1' }),
        base({ id: 'apl_ok', status: 'approved', appBlockId: 'ab_1' }),
      ],
      subscriptions: [{ appBlockId: 'ab_1', enabled: true }],
      openEvents: [],
    };

    const out = computeAppListingMetricUpdates(input);
    expect(out.map((r) => r.appListingId)).toEqual(['apl_ok']);
  });

  it('REGRESSION: adding plays does not disturb installCount', () => {
    // The play stream and the subscription table are independent sources; a
    // listing with 2 active installs and 5 raw plays still reports 2 installs.
    const listings = [base({ id: 'apl_both', kind: 'onsite', appBlockId: 'apb_alpha' })];
    const subscriptions = [
      { appBlockId: 'apb_alpha', enabled: true },
      { appBlockId: 'apb_alpha', enabled: true },
      { appBlockId: 'apb_alpha', enabled: false },
    ];

    const withoutPlays = computeAppListingMetricUpdates({
      listings,
      subscriptions,
      openEvents: [],
    });
    const withPlays = computeAppListingMetricUpdates({
      listings,
      subscriptions,
      openEvents: [
        play({ userId: 11 }),
        play({ userId: 12 }),
        play({ userId: 13, time: '2026-09-06T01:00:00.000Z' }),
      ],
    });

    expect(withoutPlays[0].installCount).toBe(2);
    expect(withPlays[0].installCount).toBe(2);
    expect(withPlays[0].openCount).toBe(3);
  });
});

describe('play dedup — one distinct actor per app per UTC day', () => {
  it('a refresh loop by ONE signed-in actor collapses to 1', () => {
    const counts = computeAppOpenCounts([
      play({ userId: 71, time: '2026-09-05T10:00:00.000Z' }),
      play({ userId: 71, time: '2026-09-05T10:00:05.000Z' }),
      play({ userId: 71, time: '2026-09-05T10:00:09.000Z' }),
      play({ userId: 71, time: '2026-09-05T23:59:59.000Z' }),
    ]);
    expect(counts.get('apb_alpha')).toBe(1);
  });

  it('two distinct userIds on the same day count 2', () => {
    const counts = computeAppOpenCounts([
      play({ userId: 71 }),
      play({ userId: 82 }),
      play({ userId: 82 }), // and a repeat, which must not add
    ]);
    expect(counts.get('apb_alpha')).toBe(2);
  });

  it('two ANONYMOUS actors on different IPs count 2', () => {
    // 🔴 The hazard: `userId` is 0 for BOTH, so an actor key built from userId
    // alone would collapse every anonymous visitor site-wide into one play.
    const counts = computeAppOpenCounts([
      play({ userId: 0, ip: '198.51.100.4' }),
      play({ userId: 0, ip: '198.51.100.9' }),
    ]);
    expect(counts.get('apb_alpha')).toBe(2);
  });

  it('the same anonymous IP twice in a day counts 1', () => {
    const counts = computeAppOpenCounts([
      play({ userId: 0, ip: '198.51.100.4', time: '2026-09-05T00:00:01.000Z' }),
      play({ userId: 0, ip: '198.51.100.4', time: '2026-09-05T18:30:00.000Z' }),
    ]);
    expect(counts.get('apb_alpha')).toBe(1);
  });

  it('the same actor on two different UTC days counts 2', () => {
    const counts = computeAppOpenCounts([
      play({ userId: 71, time: '2026-09-05T23:59:59.000Z' }),
      play({ userId: 71, time: '2026-09-06T00:00:01.000Z' }),
    ]);
    expect(counts.get('apb_alpha')).toBe(2);
  });

  it('the day boundary is UTC, not local — two instants 2s apart across midnight UTC are 2 days', () => {
    // Pinned explicitly because the SQL says `toDate(time, 'UTC')`: a bucketing
    // that used the server's local zone would merge or split these differently.
    //
    // 🔴 ON ITS OWN THIS ASSERTION IS VACUOUS WHEREVER IT ACTUALLY GATES. It only
    // fails on a runner whose local zone differs from UTC; `vitest.config.mts` pins
    // no `TZ` and CI containers are conventionally UTC, where "local" and "UTC" are
    // the same thing and a `toLocaleDateString('en-CA')` implementation passes it.
    // Measured: that mutant gave 3 failed / 45 passed under TZ=America/Chicago and
    // 48 passed — SURVIVED — under TZ=UTC. The zone-varying block below is the real
    // guard; this one is kept as the plain statement of the expected values.
    expect(appOpenUtcDay('2026-09-05T23:59:59.000Z')).toBe('2026-09-05');
    expect(appOpenUtcDay('2026-09-06T00:00:01.000Z')).toBe('2026-09-06');
  });

  it('an AUTHED actor and an ANON actor on the same day are never merged', () => {
    // Same request IP, one signed in and one not: two distinct people.
    const counts = computeAppOpenCounts([
      play({ userId: 71, ip: '198.51.100.4' }),
      play({ userId: 0, ip: '198.51.100.4' }),
    ]);
    expect(counts.get('apb_alpha')).toBe(2);
  });

  it('a userId and an ip that render the same string are still two actors', () => {
    // Without the `u:` / `i:` prefixes these two collapse: user 5 and the literal
    // ip "5" both stringify to "5".
    expect(appOpenActorKey({ userId: 5, ip: '198.51.100.4' })).not.toBe(
      appOpenActorKey({ userId: 0, ip: '5' })
    );
    const counts = computeAppOpenCounts([
      play({ userId: 5, ip: '198.51.100.4' }),
      play({ userId: 0, ip: '5' }),
    ]);
    expect(counts.get('apb_alpha')).toBe(2);
  });

  it('userId 0 is the ANONYMOUS sentinel, never an identity', () => {
    expect(appOpenActorKey({ userId: 0, ip: '198.51.100.4' })).toBe('i:198.51.100.4');
    expect(appOpenActorKey({ userId: 71, ip: '198.51.100.4' })).toBe('u:71');
  });

  it('plays are scoped per app — one actor opening two apps is 1 play each', () => {
    const counts = computeAppOpenCounts([
      play({ appBlockId: 'apb_alpha', userId: 71 }),
      play({ appBlockId: 'apb_beta', userId: 71 }),
      play({ appBlockId: 'apb_beta', userId: 71 }),
    ]);
    expect(counts.get('apb_alpha')).toBe(1);
    expect(counts.get('apb_beta')).toBe(1);
  });

  it('a row whose details carried no appBlockId is dropped, not counted under ""', () => {
    const counts = computeAppOpenCounts([play({ appBlockId: '' }), play({ userId: 71 })]);
    expect(counts.has('')).toBe(false);
    expect(counts.get('apb_alpha')).toBe(1);
  });

  it('an app block with no events has no entry (the caller reads that as 0)', () => {
    expect(computeAppOpenCounts([]).get('apb_alpha')).toBeUndefined();
  });
});

/**
 * 🔴 THE UTC-DAY RULE, PROVEN AS A PROPERTY RATHER THAN AS AN ACCIDENT OF THE
 * RUNNER'S ZONE.
 *
 * The spec⇄SQL lockstep rests on `appOpenUtcDay` mirroring `toDate(time, 'UTC')`.
 * A single-zone assertion cannot see the failure it is written to catch: on a UTC
 * runner — which `vitest.config.mts` does not pin, and which CI containers
 * conventionally are — a local-zone implementation IS the UTC one, so it passes.
 * Measured on the `toLocaleDateString('en-CA')` mutant: KILLED (3 failed / 45
 * passed) under TZ=America/Chicago, SURVIVED (48 passed) under TZ=UTC. The guard
 * held nowhere it actually gates.
 *
 * So the property is exercised under SEVERAL ambient zones, straddling the instants
 * in both directions (UTC-5 pulls a just-after-midnight instant back a day; UTC+14
 * pushes a just-before-midnight instant forward one). Whatever zone the runner is
 * in, at least two of these disagree with it.
 */
describe('appOpenUtcDay is independent of the runner ambient timezone', () => {
  const ZONES = ['UTC', 'America/Chicago', 'Asia/Kolkata', 'Pacific/Kiritimati'];
  /** Renders as the NEXT day in Kiritimati (UTC+14). */
  const LATE = '2026-09-05T23:59:59.000Z';
  /** Renders as the PREVIOUS day in Chicago (UTC-5). */
  const EARLY = '2026-09-06T00:00:01.000Z';

  function withAmbientTimezone<T>(tz: string, fn: () => T): T {
    const previous = process.env.TZ;
    process.env.TZ = tz;
    try {
      return fn();
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  }

  const localDay = (tz: string, instant: string) =>
    withAmbientTimezone(tz, () => new Date(instant).toLocaleDateString('en-CA'));

  it('POSITIVE CONTROL: the zone override actually moves a local-zone reading', () => {
    // Without this, a Node/pool combination that ignored a runtime `process.env.TZ`
    // change would turn every assertion below into a re-run of the ambient zone —
    // the exact vacuity this block exists to remove, wearing four zone names.
    expect(localDay('UTC', LATE)).toBe('2026-09-05');
    expect(localDay('Pacific/Kiritimati', LATE)).toBe('2026-09-06');
    expect(localDay('America/Chicago', EARLY)).toBe('2026-09-05');
  });

  it.each(ZONES)('bucket boundaries stay UTC under TZ=%s', (tz) => {
    withAmbientTimezone(tz, () => {
      expect(appOpenUtcDay(LATE)).toBe('2026-09-05');
      expect(appOpenUtcDay(EARLY)).toBe('2026-09-06');
    });
  });

  it.each(ZONES)('the dedup buckets by UTC day, not local day, under TZ=%s', (tz) => {
    withAmbientTimezone(tz, () => {
      // Same actor, two instants inside ONE UTC day that fall on DIFFERENT local
      // days in Kiritimati (UTC+14 renders them 23:59:59 and 00:00:01). Still 1.
      expect(
        computeAppOpenCounts([
          play({ userId: 71, time: '2026-09-05T09:59:59.000Z' }),
          play({ userId: 71, time: '2026-09-05T10:00:01.000Z' }),
        ]).get('apb_alpha')
      ).toBe(1);
      // Same actor either side of UTC midnight, which Chicago (UTC-5) renders as a
      // single local day. Still 2.
      expect(
        computeAppOpenCounts([
          play({ userId: 71, time: LATE }),
          play({ userId: 71, time: EARLY }),
        ]).get('apb_alpha')
      ).toBe(2);
    });
  });
});

describe('computeAppListingMetricUpdates — openCount projection', () => {
  const events: AppOpenEvent[] = [
    // apb_alpha: 3 distinct actors on 09-05 (two authed, one anon) + the SAME
    // authed actor again on 09-06 → 3 + 1 = 4. Deliberately not equal to the raw
    // row count (6) nor to any other fixture constant in this file.
    play({ appBlockId: 'apb_alpha', userId: 71 }),
    play({ appBlockId: 'apb_alpha', userId: 71 }),
    play({ appBlockId: 'apb_alpha', userId: 82 }),
    play({ appBlockId: 'apb_alpha', userId: 0, ip: '198.51.100.4' }),
    play({ appBlockId: 'apb_alpha', userId: 0, ip: '198.51.100.4' }),
    play({ appBlockId: 'apb_alpha', userId: 71, time: '2026-09-06T09:00:00.000Z' }),
  ];

  it('an on-site listing gets its app block’s deduped all-time play count', () => {
    const out = computeAppListingMetricUpdates({
      listings: [base({ id: 'apl_onsite', kind: 'onsite', appBlockId: 'apb_alpha' })],
      subscriptions: [],
      openEvents: events,
    });
    expect(out).toEqual([{ appListingId: 'apl_onsite', installCount: 0, openCount: 4 }]);
  });

  it('OFF-SITE listing → openCount 0, even with events on a block id it does not own', () => {
    // Off-site listings have no `app_block_id`; a play stream cannot reach them.
    const out = computeAppListingMetricUpdates({
      listings: [base({ id: 'apl_offsite', kind: 'offsite', appBlockId: null })],
      subscriptions: [],
      openEvents: events,
    });
    expect(out[0].openCount).toBe(0);
  });

  it('OFF-SITE listing carrying a stray app_block_id STILL gets 0 (kind gates it)', () => {
    // Defence in depth: the requirement is "off-site never accumulates a play
    // count". If the column were ever populated on an off-site row, the `kind`
    // gate — not the null-ness of the join key — is what has to hold.
    const out = computeAppListingMetricUpdates({
      listings: [base({ id: 'apl_offsite2', kind: 'offsite', appBlockId: 'apb_alpha' })],
      subscriptions: [{ appBlockId: 'apb_alpha', enabled: true }],
      openEvents: events,
    });
    expect(out[0].openCount).toBe(0);
    expect(out[0].installCount).toBe(0);
  });

  it('on-site listing with a null app_block_id → openCount 0', () => {
    const out = computeAppListingMetricUpdates({
      listings: [base({ id: 'apl_noblock', kind: 'onsite', appBlockId: null })],
      subscriptions: [],
      openEvents: events,
    });
    expect(out[0].openCount).toBe(0);
  });

  it('a NON-APPROVED listing is excluded even when its block has plays', () => {
    const out = computeAppListingMetricUpdates({
      listings: [
        base({ id: 'apl_pending', status: 'pending', kind: 'onsite', appBlockId: 'apb_alpha' }),
        base({ id: 'apl_ok', status: 'approved', kind: 'onsite', appBlockId: 'apb_alpha' }),
      ],
      subscriptions: [],
      openEvents: events,
    });
    expect(out.map((r) => r.appListingId)).toEqual(['apl_ok']);
  });

  it('a listing whose block has no events → openCount 0, not undefined/NaN', () => {
    const out = computeAppListingMetricUpdates({
      listings: [base({ id: 'apl_quiet', kind: 'onsite', appBlockId: 'apb_quiet' })],
      subscriptions: [],
      openEvents: events,
    });
    expect(out[0].openCount).toBe(0);
  });
});

describe('production SQL — ownership contract (regression guard)', () => {
  // Normalize whitespace so the assertions are robust to formatting.
  const upsert = APP_LISTING_METRIC_UPSERT_SQL.replace(/\s+/g, ' ');
  const doUpdate = upsert.slice(upsert.indexOf('ON CONFLICT'));

  it('the ON CONFLICT DO UPDATE writes install_count / open_count / updated_at', () => {
    expect(doUpdate).toContain('"install_count" = EXCLUDED."install_count"');
    expect(doUpdate).toContain('"open_count" = EXCLUDED."open_count"');
    expect(doUpdate).toContain('"updated_at" = NOW()');
  });

  it('NEVER writes thumbs_up_count / thumbs_down_count (owned by the review service)', () => {
    // The whole statement — insert column list AND the on-conflict set — must not
    // mention thumbs. This is the key regression guard: a metric row created by
    // the synchronous thumbs writer must survive this rollup untouched.
    expect(upsert).not.toContain('thumbs_up_count');
    expect(upsert).not.toContain('thumbs_down_count');
  });

  it('does not write connect/visit/tipped counters (no source; feature not live)', () => {
    // 🔴 DELIBERATELY NARROWED — and NOT because open_count gained a reader. It has
    // no reader at this ref; its consumer lands in stage 3. What it gained in stage
    // 2 is a trusted server-side SOURCE (the ClickHouse `App_Open` stream) feeding
    // a value that is derived and idempotent, which is what makes writing it ahead
    // of its reader safe. So it moved OUT of this list and INTO the ON CONFLICT
    // assertion above. The remaining four have no source at all: connect is a
    // locked-deferred product decision, visit is never recorded server-side, and
    // AppListing is not a BuzzTip entity. Do not cite open_count to populate them.
    expect(upsert).not.toContain('connect_count');
    expect(upsert).not.toContain('visit_count');
    // `tipped` unqualified, so BOTH tipped_count and tipped_amount_count are
    // covered — `tipped_count` is not a substring of `tipped_amount_count`, so the
    // narrower spelling silently asserted nothing about the amount column.
    expect(upsert).not.toContain('tipped');
  });

  it('the active-install filter is enabled = TRUE', () => {
    expect(upsert).toContain('bus."enabled" = TRUE');
  });

  it('open_count is DERIVED from the supplied map, never incremented', () => {
    // A `+1` path is the thing the ownership contract forbids outright. The
    // written value must be the joined map value (or 0), with no reference to the
    // column's own current value.
    expect(upsert).toContain('COALESCE(oc."open_count", 0)');
    expect(upsert).not.toMatch(/"open_count"\s*\+/);
    expect(doUpdate).not.toContain('app_listing_metrics."open_count"');
  });

  it('both counters gate on kind = onsite AND a non-null app_block_id', () => {
    const gates = upsert.match(/WHEN al\."kind" = 'onsite' AND al\."app_block_id" IS NOT NULL/g);
    // One gate for install_count, one for open_count. If a counter is added
    // without its gate, this count moves and the off-site guarantee is gone.
    expect(gates).toHaveLength(2);
  });
});

describe('production SQL — approved-only scoping', () => {
  it('the affected query scopes to approved listings', () => {
    expect(AFFECTED_APPROVED_LISTINGS_SQL).toContain(`al."status" = 'approved'`);
  });

  it('the upsert scopes to approved listings', () => {
    expect(APP_LISTING_METRIC_UPSERT_SQL).toContain(`al."status" = 'approved'`);
  });
});

describe('production SQL — affected-set discovery includes new plays', () => {
  const affected = AFFECTED_APPROVED_LISTINGS_SQL.replace(/\s+/g, ' ');

  it('has an arm keyed on the ClickHouse-supplied app_block_id list ($2)', () => {
    // Without this, a listing whose ONLY change is new plays is never recomputed:
    // nothing in Postgres moves when a play happens.
    expect(affected).toContain(`al."kind" = 'onsite' AND al."app_block_id" = ANY($2::text[])`);
  });

  it('returns app_block_id so the caller can query ClickHouse without a second round trip', () => {
    expect(affected).toContain('SELECT al.id, al."app_block_id"');
  });

  it('still has the subscription-change arm and the seed arm', () => {
    expect(affected).toContain(`bus."created_at" > $1 OR bus."updated_at" > $1`);
    expect(affected).toContain('NOT EXISTS');
  });

  it('has the REPAIR arm — a lost join key with a non-zero count still published', () => {
    // 🔴 Pinned as the WHOLE normalised arm, not a keyword. `AppListing.appBlock` is
    // `onDelete: SetNull`; once `app_block_id` goes NULL the listing matches none of
    // the three arms above (it has a metric row, so not the seed arm; the install
    // arm requires a non-null key; `NULL = ANY($2)` is NULL, never true) and a
    // published `open_count = 777` is frozen at 777 with no path to correct it. A
    // reworded-but-equivalent arm is meant to fail this and be re-read, not slip
    // through on a matching keyword. The behaviour it produces is asserted against
    // the executable spec in the block below.
    expect(affected).toContain(
      `OR ( al."app_block_id" IS NULL AND EXISTS ( SELECT 1 FROM "app_listing_metrics" m ` +
        `WHERE m."app_listing_id" = al.id AND (m."open_count" <> 0 OR m."install_count" <> 0) ) )`
    );
  });
});

/**
 * The affected-set arms, behaviourally — `selectAffectedApprovedListings` is the
 * in-memory mirror of `AFFECTED_APPROVED_LISTINGS_SQL`, so the arms are testable
 * without Postgres. The repair arm is the reason this mirror exists: its absence is
 * SILENT in production (the listing simply never comes back), so a structural
 * assertion alone would leave the behaviour unpinned.
 */
describe('affected-set selection — arms, including the repair arm', () => {
  const WATERMARK = '2026-09-05T10:00:00.000Z';
  const BEFORE = '2026-09-05T09:00:00.000Z';
  const AFTER = '2026-09-05T11:00:00.000Z';

  const affectedInput = (over: Partial<AffectedListingsInput> = {}): AffectedListingsInput => ({
    listings: [],
    metrics: [],
    subscriptions: [],
    recentlyOpenedBlockIds: [],
    since: WATERMARK,
    ...over,
  });

  it('SEED: an approved listing with no metric row is selected', () => {
    const out = selectAffectedApprovedListings(
      affectedInput({
        listings: [base({ id: 'apl_new', kind: 'onsite', appBlockId: 'apb_alpha' })],
      })
    );
    expect(out).toEqual(['apl_new']);
  });

  it('INSTALL: a subscription touched after the watermark selects its listing', () => {
    const listings = [base({ id: 'apl_1', kind: 'onsite', appBlockId: 'apb_alpha' })];
    const metrics = [{ appListingId: 'apl_1', installCount: 2, openCount: 4 }];

    expect(
      selectAffectedApprovedListings(
        affectedInput({
          listings,
          metrics,
          subscriptions: [{ appBlockId: 'apb_alpha', createdAt: BEFORE, updatedAt: AFTER }],
        })
      )
    ).toEqual(['apl_1']);

    // Untouched since the watermark → not affected. (Negative control: without it,
    // an arm that selected everything would pass the assertion above.)
    expect(
      selectAffectedApprovedListings(
        affectedInput({
          listings,
          metrics,
          subscriptions: [{ appBlockId: 'apb_alpha', createdAt: BEFORE, updatedAt: BEFORE }],
        })
      )
    ).toEqual([]);
  });

  it('PLAY: a block ClickHouse reports as opened selects its listing', () => {
    const out = selectAffectedApprovedListings(
      affectedInput({
        listings: [base({ id: 'apl_1', kind: 'onsite', appBlockId: 'apb_alpha' })],
        metrics: [{ appListingId: 'apl_1', installCount: 0, openCount: 1 }],
        recentlyOpenedBlockIds: ['apb_alpha'],
      })
    );
    expect(out).toEqual(['apl_1']);
  });

  it('REPAIR: a NULL join key with a non-zero published open_count is selected', () => {
    // The frozen-count shape: the AppBlock was deleted, `app_block_id` was
    // SetNull'd, and open_count = 777 is still on a public card.
    const out = selectAffectedApprovedListings(
      affectedInput({
        listings: [base({ id: 'apl_orphan', kind: 'onsite', appBlockId: null })],
        metrics: [{ appListingId: 'apl_orphan', installCount: 0, openCount: 777 }],
      })
    );
    expect(out).toEqual(['apl_orphan']);
  });

  it('REPAIR: also fires on a non-zero install_count, and on an OFF-SITE row', () => {
    // 🔴 THE PREDICATE IS "NULL JOIN KEY + NON-ZERO COUNT", NOT "the AppBlock was
    // deleted". `app_block_id IS NULL` is not a kind discriminator (schema.prisma
    // on `AppListing.appBlockId`), so the arm also covers a natively-created
    // off-site listing that never had a block to lose — `apl_offsite` here IS that
    // population. In production its counters are written 0 by the same upsert, so
    // the arm is a no-op over it; a row that does hold a non-zero count is wrong by
    // definition and wants the same clearing. Do not read a firing of this arm as
    // evidence of a deletion.
    const out = selectAffectedApprovedListings(
      affectedInput({
        listings: [
          base({ id: 'apl_installs', kind: 'onsite', appBlockId: null }),
          base({ id: 'apl_offsite', kind: 'offsite', appBlockId: null }),
        ],
        metrics: [
          { appListingId: 'apl_installs', installCount: 12, openCount: 0 },
          { appListingId: 'apl_offsite', installCount: 0, openCount: 5 },
        ],
      })
    );
    expect(out).toEqual(['apl_installs', 'apl_offsite']);
  });

  it('REPAIR is SELF-TERMINATING: once the counts are 0 the row stops being selected', () => {
    // 🔴 Not decoration. An arm that kept matching after the repair would put every
    // orphaned listing into every 5-minute run forever.
    const out = selectAffectedApprovedListings(
      affectedInput({
        listings: [base({ id: 'apl_orphan', kind: 'onsite', appBlockId: null })],
        metrics: [{ appListingId: 'apl_orphan', installCount: 0, openCount: 0 }],
      })
    );
    expect(out).toEqual([]);
  });

  it('END TO END: the repaired listing then recomputes to 0, not to its stale value', () => {
    // The repair is only worth anything if the upsert that follows CLEARS the
    // number. Selection + recompute, together.
    const listing = base({ id: 'apl_orphan', kind: 'onsite', appBlockId: null });
    expect(
      selectAffectedApprovedListings(
        affectedInput({
          listings: [listing],
          metrics: [{ appListingId: 'apl_orphan', installCount: 3, openCount: 777 }],
        })
      )
    ).toEqual(['apl_orphan']);

    expect(
      computeAppListingMetricUpdates({
        listings: [listing],
        subscriptions: [{ appBlockId: 'apb_alpha', enabled: true }],
        openEvents: [play({ appBlockId: 'apb_alpha', userId: 71 })],
      })
    ).toEqual([{ appListingId: 'apl_orphan', installCount: 0, openCount: 0 }]);
  });

  it('a NON-APPROVED listing is never selected, by any arm', () => {
    const out = selectAffectedApprovedListings(
      affectedInput({
        listings: [
          base({ id: 'apl_draft', status: 'draft', kind: 'onsite', appBlockId: null }),
          base({ id: 'apl_pending', status: 'pending', kind: 'onsite', appBlockId: 'apb_alpha' }),
        ],
        metrics: [{ appListingId: 'apl_draft', installCount: 0, openCount: 777 }],
        recentlyOpenedBlockIds: ['apb_alpha'],
      })
    );
    expect(out).toEqual([]);
  });

  it('a settled approved listing matches NO arm (negative control)', () => {
    // If this ever passes something through, every "is selected" assertion above is
    // vacuous — they would all be reading an arm that selects unconditionally.
    const out = selectAffectedApprovedListings(
      affectedInput({
        listings: [base({ id: 'apl_settled', kind: 'onsite', appBlockId: 'apb_alpha' })],
        metrics: [{ appListingId: 'apl_settled', installCount: 2, openCount: 4 }],
        subscriptions: [{ appBlockId: 'apb_alpha', createdAt: BEFORE, updatedAt: BEFORE }],
        recentlyOpenedBlockIds: ['apb_other'],
      })
    );
    expect(out).toEqual([]);
  });
});

describe('production SQL — the upsert consumes the play map', () => {
  const upsert = APP_LISTING_METRIC_UPSERT_SQL.replace(/\s+/g, ' ');

  it('joins the parallel (app_block_id, open_count) arrays by LEFT JOIN unnest', () => {
    expect(upsert).toContain(
      `LEFT JOIN unnest($2::text[], $3::int[]) AS oc("app_block_id", "open_count") ON oc."app_block_id" = al."app_block_id"`
    );
  });

  it('is a LEFT join, so a listing absent from the map is written 0 rather than dropped', () => {
    expect(upsert).not.toContain('INNER JOIN unnest');
    expect(upsert).toContain('COALESCE(oc."open_count", 0)');
  });
});

describe('ClickHouse SQL — App_Open reads', () => {
  const recent = buildAppOpenRecentBlockIdsSql('2026-09-05T10:00:00.000Z');
  const counts = buildAppOpenCountSql(['apb_alpha', 'apb_beta']);

  it('matches the action type by toString(type), NOT by Enum comparison', () => {
    // 🔴 `actions.type` is an Enum16. `type = 'App_Open'` is a QUERY ERROR — not an
    // empty result — until the widening migration is applied, which would take the
    // whole metric processor (install_count included) down with it. `toString(type)`
    // simply matches nothing, which is the inert behaviour this rollup wants.
    for (const sql of [recent, counts]) {
      expect(sql).toContain(`toString(type) = '${APP_OPEN_ACTION_TYPE}'`);
      expect(sql).not.toMatch(/[^(]\btype\s*=\s*'App_Open'/);
    }
  });

  it('applies the type filter in PREWHERE (the count query has no time bound to prune on)', () => {
    for (const sql of [recent, counts]) {
      expect(sql).toContain(`PREWHERE toString(type) = '${APP_OPEN_ACTION_TYPE}'`);
    }
  });

  it('reads appBlockId out of the JSON-STRING details column', () => {
    // tracker.action() JSON.stringify()s `details` before insert, so it is a String
    // column — a bare `details.appBlockId` would not resolve.
    for (const sql of [recent, counts]) {
      expect(sql).toContain(`JSONExtractString(details, 'appBlockId')`);
    }
  });

  it('the recent-blocks query is bounded by the watermark and drops empty ids', () => {
    expect(recent).toContain(`time >= parseDateTimeBestEffort('2026-09-05T10:00:00.000Z')`);
    expect(recent).toContain(`JSONExtractString(details, 'appBlockId') != ''`);
    expect(recent).toContain('SELECT DISTINCT');
  });

  it('the count query buckets by UTC day and counts DISTINCT actors per bucket', () => {
    expect(counts).toContain(`toDate(time, 'UTC') AS day`);
    expect(counts).toContain(
      `uniqExact(if(userId != 0, concat('u:', toString(userId)), concat('i:', ip))) AS dailyActors`
    );
    expect(counts).toContain('GROUP BY appBlockId, day');
    expect(counts).toContain('sum(dailyActors) AS openCount');
  });

  it('the count query is all-time (no time predicate) — AppListingMetric has no timeframe', () => {
    expect(counts).not.toContain('time >=');
    expect(counts).not.toContain('time >');
  });

  it('the count query filters to the requested app block ids', () => {
    expect(counts).toContain(
      `WHERE JSONExtractString(details, 'appBlockId') IN ('apb_alpha', 'apb_beta')`
    );
  });

  it('escapes quotes and backslashes in the IN list rather than dropping the id', () => {
    // Dropping an id would omit it from the count map, and the upsert writes a
    // missing entry as 0 — silent data loss. Escaping keeps it queryable.
    expect(escapeClickhouseString(`ap'b`)).toBe(`ap\\'b`);
    expect(escapeClickhouseString('ap\\b')).toBe('ap\\\\b');
    const sql = buildAppOpenCountSql([`ap'b`]);
    expect(sql).toContain(`IN ('ap\\'b')`);
  });
});

describe('spec ⇄ SQL lockstep', () => {
  /**
   * 🔴 A RELATIONSHIP, NOT A SPELLING. The pure spec and the upsert are a matched
   * pair; changing one without the other is exactly the drift the pair exists to
   * prevent. This derives the counter set from BOTH sides and requires them equal,
   * so it fails when either side GROWS or SHRINKS — including on a counter nobody
   * thought to name here.
   */
  const specCounters = Object.keys(
    computeAppListingMetricUpdates({
      listings: [base({ id: 'apl_probe', kind: 'onsite', appBlockId: 'apb_alpha' })],
      subscriptions: [],
      openEvents: [],
    })[0]
  )
    .filter((k) => k !== 'appListingId')
    .map((k) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`))
    .sort();

  const doUpdate = APP_LISTING_METRIC_UPSERT_SQL.replace(/\s+/g, ' ');
  const sqlCounters = [
    ...doUpdate
      .slice(doUpdate.indexOf('ON CONFLICT'))
      .matchAll(/"([a-z_]+)"\s*=\s*(?:EXCLUDED|NOW\(\))/g),
  ]
    .map((m) => m[1])
    .filter((c) => c !== 'updated_at')
    .sort();

  const insertColumns = [
    ...APP_LISTING_METRIC_UPSERT_SQL.slice(
      APP_LISTING_METRIC_UPSERT_SQL.indexOf('('),
      APP_LISTING_METRIC_UPSERT_SQL.indexOf(')')
    ).matchAll(/"([a-z_]+)"/g),
  ]
    .map((m) => m[1])
    .filter((c) => c !== 'app_listing_id' && c !== 'updated_at')
    .sort();

  it('the parser found something to compare (positive control)', () => {
    // A regex that matched nothing would make every equality below pass vacuously.
    expect(specCounters.length).toBeGreaterThan(0);
    expect(sqlCounters.length).toBeGreaterThan(0);
    expect(insertColumns.length).toBeGreaterThan(0);
  });

  it('the spec emits exactly the counters the ON CONFLICT set writes', () => {
    expect(specCounters).toEqual(sqlCounters);
  });

  it('the INSERT column list matches the ON CONFLICT set', () => {
    expect(insertColumns).toEqual(sqlCounters);
  });

  it('and that set is install_count + open_count', () => {
    // The literal, so the derived comparison above cannot drift silently in both
    // directions at once (two wrongs agreeing is still a pass for the pair test).
    expect(sqlCounters).toEqual(['install_count', 'open_count']);
  });
});

/**
 * 🔴 THE `IN` LIST IS A HARD CEILING, NOT A SLOW PATH. Measured against ClickHouse
 * 26.8.2.7: 7,000 ids returns HTTP 200 (238,460 bytes of query text); 8,000 ids
 * returns `Code: 62 Max query size exceeded`. The count read fails HARD by design,
 * so one over-long query takes `install_count` down with it — and two live triggers
 * reach that size: the seed arm on a fresh or restored `app_listing_metrics`, and
 * the store simply growing past ~7,700 approved on-site listings.
 *
 * 🔴 BUT CHUNKING SMALLER IS NOT "SAFER" — IT IS LINEARLY MORE EXPENSIVE, AND EVERY
 * ASSERTION IN THIS BLOCK IS RELATIVE TO THE CONSTANT, SO NONE OF THEM CAN SEE IT.
 * Each chunk is an unbounded `actions` scan whose cost does not shrink with the `IN`
 * list, so the chunk COUNT is the cost. The absolute block below is the guard that
 * survives the constant moving in either direction.
 */
describe('fetchAppOpenCounts — chunking and merge', () => {
  // Deliberately NOT a multiple of the chunk size: the last chunk is partial, so a
  // mutant that drops or double-counts a trailing chunk cannot land on the boundary.
  const BLOCK_COUNT = APP_OPEN_CH_CHUNK_SIZE * 2 + 37;
  const allIds = Array.from({ length: BLOCK_COUNT }, (_, i) => `apb_${i}`);
  // Per-id distinct, and distinct from the batch size, the chunk count and the
  // index — a mutant returning a constant or the wrong chunk's numbers cannot pass.
  const expectedCount = (id: string) => Number(id.slice('apb_'.length)) * 3 + 11;

  function idsIn(sql: string): string[] {
    const inList = sql.slice(sql.indexOf('IN ('));
    return [...inList.matchAll(/'([^']*)'/g)].map((m) => m[1]);
  }

  const recordingRunner = () => {
    const queries: string[] = [];
    const runQuery = async (sql: string): Promise<AppOpenCountRow[]> => {
      queries.push(sql);
      return idsIn(sql).map((id) => ({ appBlockId: id, openCount: expectedCount(id) }));
    };
    return { queries, runQuery };
  };

  it('POSITIVE CONTROL: the id extractor can actually see ids in a query', () => {
    // A regex that matched nothing would make every "chunk contents" assertion
    // below pass over an empty list.
    expect(idsIn(buildAppOpenCountSql(['apb_a', 'apb_b']))).toEqual(['apb_a', 'apb_b']);
  });

  it('splits into ceil(n / APP_OPEN_CH_CHUNK_SIZE) queries, none over the chunk size', async () => {
    const { queries, runQuery } = recordingRunner();
    await fetchAppOpenCounts(allIds, runQuery);
    expect(queries).toHaveLength(Math.ceil(BLOCK_COUNT / APP_OPEN_CH_CHUNK_SIZE));
    for (const sql of queries) {
      expect(idsIn(sql).length).toBeLessThanOrEqual(APP_OPEN_CH_CHUNK_SIZE);
    }
  });

  it('the merged map is COMPLETE and per-id correct across every chunk', async () => {
    const { runQuery } = recordingRunner();
    const counts = await fetchAppOpenCounts(allIds, runQuery);
    expect(counts.size).toBe(BLOCK_COUNT);
    for (const id of allIds) expect(counts.get(id)).toBe(expectedCount(id));
  });

  it('every id is asked about exactly once — chunks are disjoint and cover the set', async () => {
    const { queries, runQuery } = recordingRunner();
    await fetchAppOpenCounts(allIds, runQuery);
    expect(queries.flatMap(idsIn)).toEqual(allIds);
  });

  it('dedupes and drops empty ids before chunking', async () => {
    const { queries, runQuery } = recordingRunner();
    await fetchAppOpenCounts(['apb_1', 'apb_1', '', 'apb_2'], runQuery);
    expect(queries).toHaveLength(1);
    expect(idsIn(queries[0])).toEqual(['apb_1', 'apb_2']);
  });

  it('runs ZERO queries for an empty set (`IN ()` is a syntax error)', async () => {
    const { queries, runQuery } = recordingRunner();
    const counts = await fetchAppOpenCounts([], runQuery);
    expect(queries).toEqual([]);
    expect(counts.size).toBe(0);
  });

  it('coerces a string openCount (ClickHouse 64-bit rendering) to a number', async () => {
    const counts = await fetchAppOpenCounts(['apb_a'], async () => [
      { appBlockId: 'apb_a', openCount: '42' },
    ]);
    expect(counts.get('apb_a')).toBe(42);
  });

  it('a chunk failure PROPAGATES — the count read fails hard by design', async () => {
    // Asymmetric with the discovery read on purpose: `open_count` is derived, so a
    // partial map is written over live counts as 0 rather than left alone.
    await expect(
      fetchAppOpenCounts(allIds, async () => {
        throw new Error('Code: 62. DB::Exception: Max query size exceeded');
      })
    ).rejects.toThrow('Code: 62');
  });
});

/**
 * 🔴 THE ABSOLUTE BOUNDS ON THE CLICKHOUSE CHUNK SIZE. Everything in the block above
 * is stated RELATIVE to `APP_OPEN_CH_CHUNK_SIZE` ("no chunk exceeds the constant",
 * "ceil(n / the constant) queries"), so all of it stays green for ANY value of the
 * constant — including values that are a hard query error at one end and a 9.75x cost
 * regression at the other (39 scans against the 4 the split constant gives; 39x is
 * the other comparison, against the single unchunked query). That blindness is not
 * hypothetical: it is exactly how a shared constant of 200 was adopted for a query
 * whose cost is flat in its `IN` list.
 *
 * Every number below is a LITERAL, on purpose. None of them moves when
 * `APP_OPEN_CH_CHUNK_SIZE` or `APP_LISTING_BATCH_SIZE` moves, which is the whole
 * point — the constant is bracketed from BOTH sides:
 *
 *   • UPPER — ClickHouse `max_query_size` defaults to 262,144 bytes and an over-long
 *     `IN` list is `Code: 62`, not a slow query. The budget asserted here is HALF of
 *     that (131,072), because the ceiling is a per-server SETTING that can be lowered
 *     under us, not a protocol constant.
 *   • LOWER — the seed/restore path (~7,700 approved on-site listings) must not cost
 *     more than 4 full `actions` scans. At the old shared value of 200 it cost 39.
 */
describe('🔴 ABSOLUTE bounds on the ClickHouse chunk size (literals, not relatives)', () => {
  /** ClickHouse's `max_query_size` default, in bytes. A LITERAL — do not import it. */
  const MAX_QUERY_SIZE_BYTES = 262_144;
  /** Half of it: the headroom budget a full chunk must fit inside. */
  const HEADROOM_BUDGET_BYTES = MAX_QUERY_SIZE_BYTES / 2;
  /** The largest `IN` list round 1 measured returning HTTP 200 from a live server. */
  const MEASURED_SAFE_IDS = 7_000;
  /** The seed/restore population this file's docstrings size against. */
  const SEED_LISTINGS = 7_700;

  /**
   * A production-shaped id: `apb_` + a 26-char ULID = 30 chars, which renders into
   * the `IN` list as `'<id>', ` = 34 bytes. Using `apb_1` here instead would make
   * every byte figure below an underestimate — i.e. would make the guard pass a
   * chunk size that is a `Code: 62` in production.
   */
  const realisticIds = (n: number) =>
    Array.from({ length: n }, (_, i) => `apb_${String(i).padStart(26, '0')}`);
  const queryBytes = (n: number) =>
    Buffer.byteLength(buildAppOpenCountSql(realisticIds(n)), 'utf8');

  it('POSITIVE CONTROL: the byte measurement can actually exceed the ceiling', () => {
    // Without this, a `realisticIds` that silently produced short or zero ids would
    // make every "under the budget" assertion below pass over a tiny query. This
    // also re-derives round 1's live finding from the builder alone: 8,000 ids is
    // over `max_query_size`, which is the `Code: 62` it measured.
    expect(realisticIds(1)[0]).toHaveLength(30);
    expect(queryBytes(8_000)).toBeGreaterThan(MAX_QUERY_SIZE_BYTES);
  });

  it('the docstring arithmetic bytes(n) = 460 + 34n reproduces the live measurement', () => {
    // 238,460 at 7,000 ids is the figure round 1 measured against ClickHouse
    // 26.8.2.7. The builder reproducing it exactly is what licenses using the model
    // to state an EXACT ceiling instead of the 7,000/8,000 bracket.
    expect(queryBytes(MEASURED_SAFE_IDS)).toBe(238_460);
    expect(queryBytes(1)).toBe(460 + 34);
    expect(queryBytes(2_000)).toBe(460 + 34 * 2_000);
  });

  it('the EXACT hard ceiling is 7,696 ids — 7,697 does not fit', () => {
    expect(queryBytes(7_696)).toBeLessThanOrEqual(MAX_QUERY_SIZE_BYTES);
    expect(queryBytes(7_697)).toBeGreaterThan(MAX_QUERY_SIZE_BYTES);
  });

  it('🔴 UPPER BOUND: one FULL chunk of realistic ids fits in half of max_query_size', () => {
    // The assertion the relative ones cannot make. Raise APP_OPEN_CH_CHUNK_SIZE past
    // ~3,841 and this reds; raise it past 7,696 and production returns `Code: 62`
    // while every relative assertion above stays green.
    expect(queryBytes(APP_OPEN_CH_CHUNK_SIZE)).toBeLessThan(HEADROOM_BUDGET_BYTES);
  });

  it('🔴 UPPER BOUND: the chunk size never exceeds the largest list measured safe', () => {
    expect(APP_OPEN_CH_CHUNK_SIZE).toBeLessThanOrEqual(MEASURED_SAFE_IDS);
  });

  it('🔴 LOWER BOUND: the ~7,700-listing seed path costs at most 4 ClickHouse scans', async () => {
    // Each chunk is a FULL `actions` scan whose cost does not shrink with the `IN`
    // list, so the chunk count IS the cost — and also the number of chances to hit
    // the fail-hard path. At the Postgres batch size of 200 this is 39.
    const queries: string[] = [];
    await fetchAppOpenCounts(realisticIds(SEED_LISTINGS), async (sql) => {
      queries.push(sql);
      return [];
    });
    expect(queries.length).toBeLessThanOrEqual(4);
  });

  it('🔴 the ClickHouse chunk and the Postgres batch are SEPARATE, non-equal constants', () => {
    // Their optima push in opposite directions (see the two-directional-pressure
    // note on both). Re-merging them is the round-1 defect; equality is its tell.
    expect(APP_OPEN_CH_CHUNK_SIZE).not.toBe(APP_LISTING_BATCH_SIZE);
    expect(APP_OPEN_CH_CHUNK_SIZE).toBeGreaterThan(APP_LISTING_BATCH_SIZE);
  });

  it('🔴 fetchAppOpenCounts DEFAULTS to the ClickHouse constant, not the Postgres batch', async () => {
    // Called without an explicit size, as the spec tests above do. A default wired
    // back to APP_LISTING_BATCH_SIZE would reintroduce the 39-scan seed path with
    // every relative assertion still green.
    const queries: string[] = [];
    await fetchAppOpenCounts(realisticIds(SEED_LISTINGS), async (sql) => {
      queries.push(sql);
      return [];
    });
    expect(queries.length).toBe(Math.ceil(SEED_LISTINGS / APP_OPEN_CH_CHUNK_SIZE));
    expect(queries.length).toBeLessThan(Math.ceil(SEED_LISTINGS / APP_LISTING_BATCH_SIZE));
  });
});

/**
 * 🔴 THE MV-TRIGGER RUNBOOK'S DIAGNOSTIC QUERY MUST BE ABLE TO SEE THE EXPENSIVE
 * READ ALONE. Both queries in the module embed the literal `App_Open`, so the
 * obvious `system.query_log` filter matches the unbounded count scan AND the cheap
 * time-bounded discovery read — and the cheap one runs at least as often, so it
 * dominates the sample and drags `query_duration_ms` / `read_rows` down. An operator
 * reads "nowhere near the trigger" and defers the MV past the point the comment
 * exists to catch.
 */
describe('MV-trigger diagnostic — the marker discriminates the expensive read', () => {
  const recent = buildAppOpenRecentBlockIdsSql('2026-09-05T10:00:00.000Z');
  const counts = buildAppOpenCountSql(['apb_alpha']);

  it('POSITIVE CONTROL: `App_Open` alone CANNOT discriminate — both queries carry it', () => {
    // The defect being fixed, stated as an assertion rather than as prose. If this
    // ever fails, the marker below is solving a problem that no longer exists and
    // the runbook should be re-read rather than the test relaxed.
    expect(counts).toContain(APP_OPEN_ACTION_TYPE);
    expect(recent).toContain(APP_OPEN_ACTION_TYPE);
  });

  it('the marker IS present in the expensive all-time count query', () => {
    expect(counts).toContain(APP_OPEN_COUNT_QUERY_MARKER);
  });

  it('🔴 the marker is ABSENT from the cheap discovery query', () => {
    expect(recent).not.toContain(APP_OPEN_COUNT_QUERY_MARKER);
  });

  it('the marker matches the count query and names the aggregate the runbook greps for', () => {
    // ⚠️ TITLE NARROWED DELIBERATELY — it used to say "is what the count query is
    // actually built from (no second spelling)", and neither assertion can observe
    // that. Measured: replacing the interpolated `${APP_OPEN_COUNT_QUERY_MARKER}` in
    // `buildAppOpenCountSql` with a literal `sum(dailyActors)` — exactly the second
    // spelling the old title forbade — leaves this whole file GREEN, every test
    // passing. A `toContain` cannot distinguish interpolation from duplication; only
    // reading the source could, and that is not what this asserts.
    //
    // 🔴 WHERE THE RENAME HAZARD IS ACTUALLY COVERED — and the first version of this
    // note got it WRONG, which is why it is now spelled out per-mutation. It claimed
    // "three assertions in this block, including the one above". Both halves are
    // false. Measured, on the two readings of "rename the aggregate":
    //
    //   • alias only (`AS dailyActors` -> `AS dailyActrs2`, constant untouched):
    //     ONE test reds — `the count query buckets by UTC day and counts DISTINCT
    //     actors per bucket` — and NOTHING in this block does.
    //   • de-interpolate AND rename (literal `sum(dailyActrs2) AS openCount` plus the
    //     alias, constant left at `sum(dailyActors)`): THREE tests red — that same
    //     one, plus TWO in this block (`the marker IS present…` and this test).
    //
    // 🔴 `the marker is ABSENT from the cheap discovery query` PASSES UNDER BOTH and
    // always will: `recent` never contains `dailyActors` in any spelling, so its
    // `not.toContain` is satisfied whatever the count query says. It provides ZERO of
    // this coverage. Crediting it was the defect — a coverage claim wider than its
    // implementation, which is the very thing this test's own retitling was fixing.
    //
    // So the sibling that actually pins the alias literal is `the count query buckets
    // by UTC day…`; if you trim or move THAT, this hazard loses its only guard under
    // an alias-only rename.
    expect(counts).toContain(`${APP_OPEN_COUNT_QUERY_MARKER} AS openCount`);
    expect(APP_OPEN_COUNT_QUERY_MARKER).toBe('sum(dailyActors)');
  });
});

describe('fetchRecentlyOpenedBlockIds — discovery degrades, it does not fail the run', () => {
  const SINCE = '2026-09-05T10:00:00.000Z';

  it('returns the deduped, non-empty ids on a good read (positive control)', async () => {
    const seen: string[] = [];
    const out = await fetchRecentlyOpenedBlockIds(
      SINCE,
      async (sql) => {
        seen.push(sql);
        return [
          { appBlockId: 'apb_a' },
          { appBlockId: 'apb_a' },
          { appBlockId: '' },
          { appBlockId: 'apb_b' },
        ];
      },
      () => {
        throw new Error('onDegrade must not be called on a successful read');
      }
    );
    expect(out).toEqual(['apb_a', 'apb_b']);
    expect(seen[0]).toContain(`parseDateTimeBestEffort('${SINCE}')`);
  });

  it('🔴 a ClickHouse failure degrades to "no new plays" so install_count still runs', async () => {
    // The regression this exists to prevent: the discovery read happens BEFORE the
    // `if (!affected.length) return`, so a throw here aborted `update()`,
    // `setLastUpdate()` never ran, and the store's `popular` sort
    // (`install_count DESC`) froze for the whole ClickHouse outage — a pure-Postgres
    // counter held hostage, with a retry of exactly the same shape.
    const degraded: unknown[] = [];
    const out = await fetchRecentlyOpenedBlockIds(
      SINCE,
      async () => {
        throw new Error('MEMORY_LIMIT_EXCEEDED');
      },
      (error) => degraded.push(error)
    );
    expect(out).toEqual([]);
    expect(degraded).toHaveLength(1);
    expect((degraded[0] as Error).message).toBe('MEMORY_LIMIT_EXCEEDED');
  });

  it('onDegrade MAY VETO by throwing — a canceled job is not "no plays"', async () => {
    // The processor's onDegrade calls `jobContext.checkIfCanceled()` first, so an
    // aborted query surfaces as a cancellation instead of being swallowed.
    await expect(
      fetchRecentlyOpenedBlockIds(
        SINCE,
        async () => {
          throw new Error('The user aborted a request.');
        },
        () => {
          throw new Error('Job was canceled');
        }
      )
    ).rejects.toThrow('Job was canceled');
  });

  /**
   * 🔴 THE SOFT PATH COVERS *ONE* FAILURE MODE — "ClickHouse could not answer" —
   * AND MUST NOT COVER PROGRAMMING ERRORS. The `try` used to wrap the SQL builder,
   * the awaited query AND the `rows.map(...)`. Under that shape a builder throw or a
   * non-array result returns `[]` on EVERY run, not just this one: the play arm
   * never fires, and any listing whose only change is new plays is never recomputed
   * again. Unlike a ClickHouse blip, that does not self-heal on the next watermark —
   * and the only outward sign is a per-run warning log, which cannot distinguish
   * "blipped once" from "dead for a week" (hence the Prometheus counter on the
   * processor's onDegrade).
   *
   * These two cases fail ONLY when the `try` is widened back, which is what makes
   * them the guard rather than decoration.
   */
  it('🔴 a BUILDER throw PROPAGATES — it is a bug, not a ClickHouse outage', async () => {
    // The builder runs `escapeClickhouseString(sinceIso).replace(...)`; a non-string
    // watermark is a TypeError inside it. It is constructed OUTSIDE the try, so it
    // must surface. Widen the try and this degrades to [] instead.
    const degraded: unknown[] = [];
    await expect(
      fetchRecentlyOpenedBlockIds(
        null as unknown as string,
        async () => [],
        (error) => degraded.push(error)
      )
    ).rejects.toThrow(TypeError);
    expect(degraded).toEqual([]);
  });

  it('🔴 a non-array result PROPAGATES from rows.map — a contract violation, not an outage', async () => {
    // The exact edit the audit named: a later change makes the result non-array, so
    // `.map` is a TypeError. Inside the try that is silently "no plays", forever.
    const degraded: unknown[] = [];
    await expect(
      fetchRecentlyOpenedBlockIds(
        SINCE,
        async () => undefined as unknown as { appBlockId: string }[],
        (error) => degraded.push(error)
      )
    ).rejects.toThrow(TypeError);
    expect(degraded).toEqual([]);
  });

  it('NEGATIVE CONTROL: a genuine query REJECTION still degrades, in the same file', async () => {
    // The pair matters: the two assertions above must not be satisfiable by simply
    // deleting the try. Same function, same shape of failure, opposite outcome.
    const degraded: unknown[] = [];
    await expect(
      fetchRecentlyOpenedBlockIds(
        SINCE,
        async () => {
          throw new TypeError('socket hang up');
        },
        (error) => degraded.push(error)
      )
    ).resolves.toEqual([]);
    expect(degraded).toHaveLength(1);
  });
});
