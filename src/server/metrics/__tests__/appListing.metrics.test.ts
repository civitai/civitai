import { describe, expect, it } from 'vitest';

import {
  AFFECTED_APPROVED_LISTINGS_SQL,
  APP_LISTING_METRIC_UPSERT_SQL,
  APP_OPEN_ACTION_TYPE,
  appOpenActorKey,
  appOpenUtcDay,
  buildAppOpenCountSql,
  buildAppOpenRecentBlockIdsSql,
  computeAppListingMetricUpdates,
  computeAppOpenCounts,
  escapeClickhouseString,
  type AppListingComputeInput,
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

  it('does not write connect/visit/tipped counters (no reader; feature not live)', () => {
    // 🔴 DELIBERATELY NARROWED. This guard used to include `open_count`, on the
    // grounds that nothing read it. Stage 2 gave it a reader and a trusted source
    // (the ClickHouse `App_Open` stream), so open_count moved OUT of this list and
    // INTO the ON CONFLICT assertion above. The remaining three are unchanged:
    // connect is a locked-deferred product decision, visit has no server-side
    // source, and AppListing is not a BuzzTip entity.
    expect(upsert).not.toContain('connect_count');
    expect(upsert).not.toContain('visit_count');
    expect(upsert).not.toContain('tipped_count');
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
