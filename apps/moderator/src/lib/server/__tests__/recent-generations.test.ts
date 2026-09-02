import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The 24-hour job count on User Lookup's generation section.
 *
 * It read `orchestration.textToImageJobs`, which stopped being written on 2025-06-13. A dead read here
 * returns 0, and 0 is a perfectly ordinary answer for an account — so the card asserted "no generation
 * activity" about every user on the site for more than a year and nothing contradicted it. These cases
 * pin the two properties whose absence is silent.
 */

const query = vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []);
vi.mock('../clickhouse', () => ({ getClickhouse: () => ({ $query: query }) }));
vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));

const { getRecentGenerations } = await import('../user-signals.service');

beforeEach(() => {
  vi.clearAllMocks();
  query.mockResolvedValue([{ count: '7' }]);
});

const sqlOf = async () => {
  await getRecentGenerations(42);
  return String(query.mock.calls[0][0]);
};

describe('getRecentGenerations', () => {
  it('reads the live jobs table, not the one that stopped being written', async () => {
    const sql = await sqlOf();

    expect(sql).toContain('orchestration.jobs');
    // Named explicitly: reverting to it is the regression, and it fails by returning a plausible
    // number rather than by erroring.
    expect(sql).not.toContain('textToImageJobs');
  });

  it('bounds the window at both ends', async () => {
    const sql = await sqlOf();

    expect(sql).toContain('INTERVAL 24 HOUR');
    // `orchestration.jobs` holds rows dated centuries ahead — 86 of them on real accounts. Without the
    // upper bound one of those pins an account's "last 24 hours" count permanently above zero.
    expect(sql).toMatch(/createdAt\s*<=\s*now\(\)/);
  });

  it("scopes to the account, which is what excludes the platform's own work", async () => {
    const sql = await sqlOf();

    // `ConvertImage`, `MediaHash`, `WDTagging` and friends are booked to userId 0 — 3.4M of them a day.
    // The scope is the only thing keeping them out; there is no jobType allowlist to lean on.
    expect(sql).toContain('userId = 42');
  });

  it('reports the count, and 0 only when the query says so', async () => {
    expect(await getRecentGenerations(42)).toBe(7);

    query.mockResolvedValue([]);
    expect(await getRecentGenerations(42)).toBe(0);
  });
});
