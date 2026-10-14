import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// `~/server/db/client` has a canonical mock registered globally (src/__tests__/setup.ts); this
// file must not re-register it. `dbRead.$queryRaw` defaults to [] there, which is exactly the
// "no recent incidents" path this test wants.
import { resetSharedMocks, setEnv } from '~/__tests__/mocks';

// The `Overall:` line of check_site_status is read by an LLM that drafts customer replies, so
// it must not claim the platform is healthy while an individual dependency is failing.
//
// That became possible when the DB write checks were made soft for pod READINESS: /api/health
// answers 200 with `healthy: true` during a write-primary stall, by design. A summary derived
// from `healthy` would print "Overall: HEALTHY" three lines above "Database (write): FAILING".

// `~/env/server` is NOT registered here on purpose. It is globally mocked with a stable Proxy
// (src/__tests__/setup.ts) and is first on PENDING_SPECIFIERS — i.e. the same `isolate: false`
// cross-file poisoning class this file's neighbours are exposed to, since they share the
// freshdesk-investigation-tools module graph. Both values are read at CALL time, so per-test
// `setEnv` in beforeEach is sufficient and registers nothing.
//
// The clickhouse mock stays, but NOT for the reason first given here: the real shim gates
// construction on CLICKHOUSE_HOST/USERNAME, neither of which is in the test env defaults, so it
// would evaluate to `undefined` and construct nothing. What the mock actually buys is not
// importing `@civitai/clickhouse/client` at all. Cheap and defensible — just not load-bearing.
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/http/nowpayments/nowpayments.caller', () => ({ default: {} }));
vi.mock('~/server/freshdesk-agent/freshdesk-debug', () => ({ agentLog: vi.fn() }));

import { checkSiteStatus } from '~/server/freshdesk-agent/freshdesk-investigation-tools';

const ALL_OK = {
  healthy: true,
  write: true,
  read: true,
  pgWrite: true,
  pgRead: true,
  searchMetrics: true,
  redis: true,
  sysRedis: true,
  clickhouse: true,
};

function stubHealth(body: Record<string, unknown>, ok = true, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok, status, json: async () => body }))
  );
}

// The line under test, extracted so a formatting change elsewhere in the report cannot make
// these assertions silently stop matching anything.
const overallLine = (report: string) => report.split('\n').find((l) => l.startsWith('Overall:'));

beforeEach(() => {
  resetSharedMocks();
  vi.unstubAllGlobals();
  setEnv({ NEXTAUTH_URL: 'https://example.test', WEBHOOK_TOKEN: 'tok' });
});

// The last test's fetch stub would otherwise outlive the file. Harmless under `isolate: true`
// (the default today) and a cross-file leak under `--no-isolate`, which the suite is being
// moved toward — so restore it here rather than relying on the isolation regime.
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('checkSiteStatus — the Overall line', () => {
  // Positive control first: without it, a test asserting DEGRADED could pass because the
  // report never says HEALTHY under any circumstances.
  it('every dependency healthy → Overall: HEALTHY', async () => {
    stubHealth(ALL_OK);
    expect(overallLine(await checkSiteStatus())).toBe('Overall: HEALTHY');
  });

  // THE regression guard. `healthy: true` with a failing write pair is the exact shape
  // /api/health now returns during a write-primary stall.
  it('readiness says healthy but the write checks are failing → Overall: DEGRADED', async () => {
    stubHealth({ ...ALL_OK, write: false, pgWrite: false });
    const report = await checkSiteStatus();
    expect(overallLine(report)).toBe('Overall: DEGRADED');
    // And the per-check detail is still rendered, so the reader can see WHICH dependency.
    expect(report).toContain('Database (write): FAILING');
    expect(report).toContain('Database (read): OK');
  });

  // The other soft dependency, for the same reason — sysRedis has been non-critical for
  // readiness since a 2026-06-26 incident and has the same reporting hazard.
  it('readiness says healthy but sysRedis is failing → Overall: DEGRADED', async () => {
    stubHealth({ ...ALL_OK, sysRedis: false });
    expect(overallLine(await checkSiteStatus())).toBe('Overall: DEGRADED');
  });

  // An ABSENT key must not read as a failing check. /api/health omits a check's key from the
  // response when it did not run, so the value arrives as `undefined` — and folding that into
  // the verdict reports a permanent false DEGRADED. Disabling a dependency on purpose is the
  // likeliest reason for absence, which is why this case is written around it, but the report
  // must not claim that cause and neither should this title. Three states, not two.
  it('a check whose key is ABSENT → still Overall: HEALTHY, rendered as NOT REPORTED', async () => {
    const { clickhouse: _omitted, ...withoutClickhouse } = ALL_OK;
    stubHealth(withoutClickhouse);
    const report = await checkSiteStatus();
    expect(overallLine(report)).toBe('Overall: HEALTHY');
    expect(report).toContain('ClickHouse: NOT REPORTED');
    // The checks that DID run are still reported normally.
    expect(report).toContain('Database (write): OK');
  });

  // …but an absent key must not become a blanket excuse: a real failure alongside a disabled
  // check still reports DEGRADED.
  it('a disabled check AND a real failure → Overall: DEGRADED', async () => {
    const { clickhouse: _omitted, ...rest } = ALL_OK;
    stubHealth({ ...rest, write: false });
    const report = await checkSiteStatus();
    expect(overallLine(report)).toBe('Overall: DEGRADED');
    expect(report).toContain('ClickHouse: NOT REPORTED');
    expect(report).toContain('Database (write): FAILING');
  });

  // 🔴 `.every()` on an empty array is vacuously TRUE, so a body with no check keys at all
  // would otherwise report HEALTHY on the strength of having measured nothing. That is the one
  // verdict this report must never give, and /api/health can genuinely produce that body.
  it('a 200 body with NO check keys → Overall: UNKNOWN, never HEALTHY', async () => {
    stubHealth({ healthy: true });
    const report = await checkSiteStatus();
    expect(overallLine(report)).toBe('Overall: UNKNOWN (no checks reported)');
    expect(report).not.toContain('Overall: HEALTHY');
  });

  // INVARIANT GUARD: unchanged behaviour, but adjacent to the edit and cheap to pin.
  it('a non-OK response → Overall: UNKNOWN, not DEGRADED', async () => {
    stubHealth({}, false, 500);
    expect(overallLine(await checkSiteStatus())).toBe(
      'Overall: UNKNOWN (Health endpoint returned 500)'
    );
  });
});
