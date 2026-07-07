import { describe, expect, it } from 'vitest';

import {
  AFFECTED_APPROVED_LISTINGS_SQL,
  APP_LISTING_METRIC_UPSERT_SQL,
  computeAppListingMetricUpdates,
  type AppListingComputeInput,
} from '~/server/metrics/appListing.metrics.sql';

/**
 * W13 — AppListingMetric install/connect ROLLUP job.
 *
 * The SQL runs in Postgres; `computeAppListingMetricUpdates` is the executable
 * spec that mirrors it, so the aggregate invariants are testable without a DB.
 * The final block asserts the invariants directly against the production SQL
 * strings (the thumbs-ownership contract is enforced structurally there).
 */

const base = (over: Partial<AppListingComputeInput['listings'][number]>) => ({
  id: 'apl_1',
  kind: 'onsite' as const,
  status: 'approved',
  appBlockId: null,
  connectClientId: null,
  ...over,
});

describe('computeAppListingMetricUpdates — install/connect aggregate spec', () => {
  it('on-site approved listing → installCount = its ACTIVE (enabled) subscription count; connectCount 0', () => {
    const input: AppListingComputeInput = {
      listings: [base({ id: 'apl_onsite', kind: 'onsite', appBlockId: 'ab_1' })],
      subscriptions: [
        { appBlockId: 'ab_1', enabled: true },
        { appBlockId: 'ab_1', enabled: true },
        { appBlockId: 'ab_1', enabled: true },
        { appBlockId: 'ab_1', enabled: false }, // toggled-off → NOT an active install
        { appBlockId: 'ab_other', enabled: true }, // different app → excluded
      ],
      consents: [],
    };

    expect(computeAppListingMetricUpdates(input)).toEqual([
      { appListingId: 'apl_onsite', installCount: 3, connectCount: 0 },
    ]);
  });

  it('off-site listing → installCount 0 (installs are on-site only)', () => {
    const input: AppListingComputeInput = {
      listings: [base({ id: 'apl_offsite', kind: 'offsite', connectClientId: 'client_1' })],
      // Even if a subscription somehow matched, an off-site listing must never
      // count installs — the CASE gates on kind='onsite'.
      subscriptions: [{ appBlockId: 'ab_1', enabled: true }],
      consents: [{ clientId: 'client_1' }],
    };

    const [row] = computeAppListingMetricUpdates(input);
    expect(row.installCount).toBe(0);
  });

  it('off-site connect listing → connectCount = its active OauthConsent count', () => {
    const input: AppListingComputeInput = {
      listings: [base({ id: 'apl_connect', kind: 'offsite', connectClientId: 'client_1' })],
      subscriptions: [],
      consents: [
        { clientId: 'client_1' },
        { clientId: 'client_1' },
        { clientId: 'client_other' }, // different client → excluded
      ],
    };

    expect(computeAppListingMetricUpdates(input)).toEqual([
      { appListingId: 'apl_connect', installCount: 0, connectCount: 2 },
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
      consents: [],
    };

    const out = computeAppListingMetricUpdates(input);
    expect(out.map((r) => r.appListingId)).toEqual(['apl_ok']);
  });
});

describe('production SQL — thumbs-ownership contract (regression guard)', () => {
  // Normalize whitespace so the assertions are robust to formatting.
  const upsert = APP_LISTING_METRIC_UPSERT_SQL.replace(/\s+/g, ' ');
  const doUpdate = upsert.slice(upsert.indexOf('ON CONFLICT'));

  it('the ON CONFLICT DO UPDATE writes ONLY install_count / connect_count / updated_at', () => {
    expect(doUpdate).toContain('"install_count" = EXCLUDED."install_count"');
    expect(doUpdate).toContain('"connect_count" = EXCLUDED."connect_count"');
    expect(doUpdate).toContain('"updated_at" = NOW()');
  });

  it('NEVER writes thumbs_up_count / thumbs_down_count (owned by the review service)', () => {
    // The whole statement — insert column list AND the on-conflict set — must not
    // mention thumbs. This is the key regression guard: a metric row created by
    // the synchronous thumbs writer must survive this rollup untouched.
    expect(upsert).not.toContain('thumbs_up_count');
    expect(upsert).not.toContain('thumbs_down_count');
  });

  it('the active-install filter is enabled = TRUE', () => {
    expect(upsert).toContain('bus."enabled" = TRUE');
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
