import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Guard coverage for `fetchDownloadCount`.
 *
 * The contract under test: the helper admits a rate-limit key only after
 * proving it is a bare integer or a bare IP address, and a key of any other
 * shape is refused loudly rather than used. These tests pin that the decision
 * is made by VALIDATION and not by a character test, and that the emitted query
 * text contains only what this query's own literals need.
 */

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));

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

import { fetchDownloadCount } from '../download-count';

/** The full query text ClickHouse was asked to run on the last call. */
function lastQuery(): string {
  const calls = mockQuery.mock.calls;
  return calls[calls.length - 1][0] as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockQuery.mockResolvedValue([{ count: 7 }]);
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
