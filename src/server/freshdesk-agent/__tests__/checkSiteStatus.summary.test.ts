import { describe, it, expect, vi, beforeEach } from 'vitest';
// `~/server/db/client` has a canonical mock registered globally (src/__tests__/setup.ts); this
// file must not re-register it. `dbRead.$queryRaw` defaults to [] there, which is exactly the
// "no recent incidents" path this test wants.
import { resetSharedMocks } from '~/__tests__/mocks';

// The `Overall:` line of check_site_status is read by an LLM that drafts customer replies, so
// it must not claim the platform is healthy while an individual dependency is failing.
//
// That became possible when the DB write checks were made soft for pod READINESS: /api/health
// answers 200 with `healthy: true` during a write-primary stall, by design. A summary derived
// from `healthy` would print "Overall: HEALTHY" three lines above "Database (write): FAILING".

vi.mock('~/env/server', () => ({
  env: { NEXTAUTH_URL: 'https://example.test', WEBHOOK_TOKEN: 'tok' },
}));
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

  // INVARIANT GUARD: unchanged behaviour, but adjacent to the edit and cheap to pin.
  it('a non-OK response → Overall: UNKNOWN, not DEGRADED', async () => {
    stubHealth({}, false, 500);
    expect(overallLine(await checkSiteStatus())).toBe(
      'Overall: UNKNOWN (Health endpoint returned 500)'
    );
  });
});
