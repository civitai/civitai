import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';

/**
 * Guard coverage for `fetchDownloadCount`.
 *
 * The contract under test: the helper admits a rate-limit key only after
 * proving it is a bare integer or a bare IP address, and a key of any other
 * shape is refused loudly rather than used. These tests pin that the decision
 * is made by VALIDATION and not by a character test, and that the emitted query
 * text contains only what this query's own literals need.
 */

const { mockQuery, mockDedicatedQuery, dedicatedState, isFliptSyncMock } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  // The dedicated downloads replica: (statement, query params) per read.
  mockDedicatedQuery: vi.fn(),
  dedicatedState: { configured: false, flags: {} as Record<string, boolean | null> },
  isFliptSyncMock: vi.fn(),
}));

vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: {
    $query: (strings: TemplateStringsArray | string, ...values: unknown[]) => {
      const text =
        typeof strings === 'string'
          ? strings
          : strings.reduce((acc, part, i) => acc + part + (values[i] ?? ''), '');
      return mockQuery(text);
    },
  },
}));

vi.mock('~/server/clickhouse/downloads-client', () => ({
  get clickhouseDownloads() {
    return dedicatedState.configured ? {} : undefined;
  },
  queryDownloadsClickhouse: (query: string, params?: Record<string, unknown>) =>
    mockDedicatedQuery(query, params),
}));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFliptSync: isFliptSyncMock,
  // An initialised client, so a null read does not try to start one.
  getFliptClientSync: () => ({}),
}));

import promClient from 'prom-client';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';
import { resetDownloadsClickhouseGatesForTests } from '~/server/services/downloads-clickhouse';
import { downloadIpHash, fetchDownloadCount } from '../download-count';

/** The full query text ClickHouse was asked to run on the last call. */
function lastQuery(): string {
  const calls = mockQuery.mock.calls;
  return calls[calls.length - 1][0] as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockQuery.mockResolvedValue([{ count: 7 }]);
  dedicatedState.configured = false;
  dedicatedState.flags = {};
  isFliptSyncMock.mockImplementation((key: string) => dedicatedState.flags[key] ?? null);
  resetDownloadsClickhouseGatesForTests();
  resetEnv();
});

describe('fetchDownloadCount — accepted key shapes', () => {
  it('a numeric user id filters on userId', async () => {
    await expect(fetchDownloadCount('4242')).resolves.toBe(7);
    expect(lastQuery()).toContain('AND userId = 4242');
    expect(lastQuery()).not.toContain('AND ip =');
  });

  it('an IPv4 address filters on ip', async () => {
    await expect(fetchDownloadCount('203.0.113.7')).resolves.toBe(7);
    expect(lastQuery()).toContain("AND ip = '203.0.113.7'");
    expect(lastQuery()).not.toContain('AND userId =');
  });

  it('an IPv6 address filters on ip', async () => {
    await fetchDownloadCount('2001:db8::1');
    expect(lastQuery()).toContain("AND ip = '2001:db8::1'");
  });

  // Every resume of a download records another event; a reseed counting them all would charge the
  // repeats the route lets through for free.
  it('counts each version once, however many times it was downloaded', async () => {
    await fetchDownloadCount('4242');
    expect(lastQuery()).toMatch(/SELECT\s+COUNT\(DISTINCT modelVersionId\) as count\s+FROM/);
  });

  it('an empty result set reads as zero', async () => {
    mockQuery.mockResolvedValue([]);
    await expect(fetchDownloadCount('4242')).resolves.toBe(0);
  });
});

describe('fetchDownloadCount — refused key shapes', () => {
  // Most of these contain a '.' or ':' and so pass the character test that
  // shape validation replaces. They are the reason validation, not a character
  // test, is what decides the branch.
  const REFUSED = [
    "203.0.113.7' OR '1'='1",
    "1.2.3.4'; SELECT 1 --",
    "' UNION ALL SELECT 1 --",
    '203.0.113.7 AND userId = 1',
    '203.0.113.999',
    '203.0.113.7:8080',
    'user:4242',
    'example.com',
    '',
    '42abc',
    '-1',
    // Digits followed by a newline and more text. `^`/`$` without the `m` flag
    // anchor to the whole string, so this is refused; with `m` they anchor
    // per-line and the first line alone would satisfy the integer shape. The
    // two cases below are here so that adding that one flag cannot pass an
    // unvalidated remainder through as a user id.
    '123\nDROP',
    '123\n',
    // Zone-scoped IPv6. `net.isIP` accepts these — at UNBOUNDED length — so a
    // key shaped like this reaches the query text unless the validation refuses
    // the zone id specifically. It carries no quote, so this is a key-space and
    // query-size property rather than an injection one; it is refused because
    // an accepted key has to be bounded.
    'fe80::1%eth0',
    '2001:db8::1%eth0',
    'fe80::1%' + 'a'.repeat(4096),
  ];

  it.each(REFUSED)('refuses %j without building a query', async (key) => {
    await expect(fetchDownloadCount(key)).rejects.toThrow(
      /rate-limit key is neither a user id nor an IP address/
    );
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('POSITIVE CONTROL: node accepts the zone-scoped keys this refuses', async () => {
    // Without this, refusing `fe80::1%eth0` proves nothing — it would look the
    // same if that string were simply not an address. `net.isIP` says it is.
    const { isIP } = await import('node:net');
    expect(isIP('fe80::1%eth0')).toBe(6);
    expect(isIP('fe80::1%' + 'a'.repeat(4096))).toBe(6);
  });

  it('every key that IS accepted is bounded in length', async () => {
    // The consequence of refusing the zone id, stated as the property the query
    // text depends on: an accepted address contributes at most 45 characters.
    for (const key of [
      '203.0.113.7',
      '2001:db8::1',
      '0000:0000:0000:0000:0000:ffff:255.255.255.255',
    ]) {
      vi.clearAllMocks();
      mockQuery.mockResolvedValue([{ count: 0 }]);
      await fetchDownloadCount(key);
      expect(key.length).toBeLessThanOrEqual(45);
      expect(lastQuery()).toContain(`AND ip = '${key}'`);
    }
  });

  it('POSITIVE CONTROL: the harness does observe a query for an accepted key', async () => {
    // Without this, every `expect(mockQuery).not.toHaveBeenCalled()` above is
    // indistinguishable from a spy that is wired to nothing.
    await fetchDownloadCount('203.0.113.7');
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(lastQuery()).toContain('FROM modelVersionEvents');
  });

  it('no interpolated value can carry a quote into the query text', async () => {
    // The complement of the list above, stated as the property rather than the
    // enumeration: for every key that IS accepted, the emitted text contains
    // exactly the two quotes this query's own literals need.
    for (const key of ['4242', '203.0.113.7', '2001:db8::1', '0']) {
      vi.clearAllMocks();
      mockQuery.mockResolvedValue([{ count: 0 }]);
      await fetchDownloadCount(key);
      const quotes = (lastQuery().match(/'/g) ?? []).length;
      expect(quotes).toBe(key === '4242' || key === '0' ? 2 : 4);
    }
  });
});

describe('fetchDownloadCount — no ClickHouse configured', () => {
  it('reads as zero rather than throwing', async () => {
    vi.resetModules();
    vi.doMock('~/server/clickhouse/client', () => ({ clickhouse: undefined }));
    const { fetchDownloadCount: fn } = await import('../download-count');
    await expect(fn('203.0.113.7')).resolves.toBe(0);
    vi.doUnmock('~/server/clickhouse/client');
  });
});

describe('downloadIpHash', () => {
  // Computed by ClickHouse itself for the same key and address (the first 8 bytes of
  // SHA256(key || address) are 9C50B8D493DE8476, read as a little-endian UInt64). A hash that
  // differs from the replica's by one bit matches no row, and the anonymous count silently reads 0.
  it('matches the replica-side hash for a known key and address', () => {
    expect(downloadIpHash('0123456789abcdef0123456789abcdef', '203.0.113.7')).toBe(
      8540195519911710876n
    );
  });
});

// The "flag off", "without the dedicated client" and malformed-key cases are INVARIANT guards: they
// hold on the code before the dedicated replica existed too, and pin that adding it changed nothing
// while it is not selected and that the key validation still runs first.
describe('fetchDownloadCount — the dedicated downloads replica', () => {
  const FLAG = 'download-count-dedicated-clickhouse';
  const HASH_KEY = '0123456789abcdef0123456789abcdef';

  const fallbacks = async (reason: string) => {
    const metric = promClient.register.getSingleMetric(
      'civitai_app_downloads_clickhouse_fallback_total'
    );
    if (!metric) throw new Error('fallback counter is not registered');
    const { values } = await metric.get();
    return (
      values.find((v) => v.labels.site === 'download-count' && v.labels.reason === reason)?.value ??
      0
    );
  };

  beforeEach(() => {
    dedicatedState.configured = true;
    // Distinct from the shared client's 7, so the returned count names the client that answered.
    mockDedicatedQuery.mockResolvedValue([{ count: 3 }]);
    setEnv({ CLICKHOUSE_DOWNLOADS_IP_HASH_KEY: HASH_KEY });
  });

  it('flag off: both branches read the shared client only', async () => {
    dedicatedState.flags[FLAG] = false;

    await expect(fetchDownloadCount('4242')).resolves.toBe(7);
    await expect(fetchDownloadCount('203.0.113.7')).resolves.toBe(7);
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockDedicatedQuery).not.toHaveBeenCalled();
  });

  it('flag on, user id: counts the per-user table on the replica, the id as a parameter', async () => {
    dedicatedState.flags[FLAG] = true;

    await expect(fetchDownloadCount('4242')).resolves.toBe(3);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockDedicatedQuery).toHaveBeenCalledTimes(1);
    const [query, params] = mockDedicatedQuery.mock.calls[0];
    expect(query.replace(/\s+/g, ' ').trim()).toBe(
      'SELECT COUNT(DISTINCT modelVersionId) AS count FROM userModelDownloads WHERE userId = {userId:UInt64} AND lastDownloaded > now() - INTERVAL 24 HOUR'
    );
    expect(params).toEqual({ userId: '4242' });
  });

  it('flag on, address: counts the hashed table, and neither the address nor the key reaches the replica', async () => {
    dedicatedState.flags[FLAG] = true;

    await expect(fetchDownloadCount('203.0.113.7')).resolves.toBe(3);
    expect(mockQuery).not.toHaveBeenCalled();
    const [query, params] = mockDedicatedQuery.mock.calls[0];
    expect(query.replace(/\s+/g, ' ').trim()).toBe(
      'SELECT COUNT(DISTINCT modelVersionId) AS count FROM modelVersionDownloads_48h WHERE ipHash = {h:UInt64} AND time > now() - INTERVAL 24 HOUR'
    );
    expect(params).toEqual({ h: 8540195519911710876n });
    const sent = JSON.stringify([query, String(params.h)]);
    expect(sent).not.toContain('203.0.113.7');
    expect(sent).not.toContain(HASH_KEY);
  });

  it('flag on without the hash key: the address branch stays on the shared client, the user branch moves', async () => {
    dedicatedState.flags[FLAG] = true;
    setEnv({ CLICKHOUSE_DOWNLOADS_IP_HASH_KEY: undefined });

    await expect(fetchDownloadCount('203.0.113.7')).resolves.toBe(7);
    expect(lastQuery()).toContain("AND ip = '203.0.113.7'");
    expect(mockDedicatedQuery).not.toHaveBeenCalled();

    await expect(fetchDownloadCount('4242')).resolves.toBe(3);
    expect(mockDedicatedQuery).toHaveBeenCalledTimes(1);
  });

  it('flag on without the dedicated client: the shared client, as before', async () => {
    dedicatedState.configured = false;
    dedicatedState.flags[FLAG] = true;

    await expect(fetchDownloadCount('4242')).resolves.toBe(7);
    expect(mockDedicatedQuery).not.toHaveBeenCalled();
  });

  it('a failed replica read is re-run once on the shared client and counted', async () => {
    dedicatedState.flags[FLAG] = true;
    mockDedicatedQuery.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const before = await fallbacks('error');

    await expect(fetchDownloadCount('4242')).resolves.toBe(7);
    expect(mockDedicatedQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(lastQuery()).toContain('AND userId = 4242');
    expect((await fallbacks('error')) - before).toBe(1);
  });

  it('a timed-out replica read is counted as a timeout', async () => {
    dedicatedState.flags[FLAG] = true;
    mockDedicatedQuery.mockRejectedValueOnce(new Error('Timeout error.'));
    const before = await fallbacks('timeout');

    await expect(fetchDownloadCount('203.0.113.7')).resolves.toBe(7);
    expect(lastQuery()).toContain("AND ip = '203.0.113.7'");
    expect((await fallbacks('timeout')) - before).toBe(1);
  });

  it('refuses a malformed key before either client is asked', async () => {
    dedicatedState.flags[FLAG] = true;

    await expect(fetchDownloadCount("203.0.113.7' OR '1'='1")).rejects.toThrow(
      /rate-limit key is neither a user id nor an IP address/
    );
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockDedicatedQuery).not.toHaveBeenCalled();
  });
});
