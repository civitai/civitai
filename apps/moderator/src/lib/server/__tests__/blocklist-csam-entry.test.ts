import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * blocked_images keeps the newest row per hash when it merges, so any later row over a hash with a
 * CSAM entry replaces that entry. Neither a block of another reason nor an unblock may write one.
 */

const ch = vi.hoisted(() => ({
  inserts: [] as { table: string; values: unknown[] }[],
  liveRows: [] as { hash: string; reason: string }[],
  csamHashes: [] as string[],
}));

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/notifications', () => ({ getNotifications: () => ({}) }));
vi.mock('$lib/server/clickhouse', () => ({
  getClickhouse: () => ({
    query: async ({ query }: { query: string }) => ({
      json: async () =>
        query.includes("reason = 'CSAM'") ? ch.csamHashes.map((hash) => ({ hash })) : ch.liveRows,
    }),
    insert: async ({ table, values }: { table: string; values: unknown[] }) => {
      ch.inserts.push({ table, values });
    },
  }),
}));

const { addImagesToBlocklist, removeImagesFromBlocklist } = await import(
  '../image-moderation-effects'
);

const CSAM_HASH = '-4276845791567733103';
const OTHER = '1234567890123';
const tosImage = (pHash: string) => ({ pHash, needsReview: null, blockedFor: 'moderated' });

beforeEach(() => {
  ch.inserts = [];
  ch.liveRows = [];
  ch.csamHashes = [CSAM_HASH];
});

describe('a hash with a CSAM entry keeps it', () => {
  it('an unblock disables none of its rows and still disables an unrelated hash', async () => {
    ch.liveRows = [
      { hash: CSAM_HASH, reason: 'TOS' },
      { hash: OTHER, reason: 'TOS' },
    ];

    await removeImagesFromBlocklist([CSAM_HASH, OTHER]);

    expect(ch.inserts).toEqual([
      { table: 'blocked_images', values: [{ hash: OTHER, reason: 'TOS', disabled: true }] },
    ]);
  });

  it('a block of another reason is not written over it, while one on another hash lands', async () => {
    await addImagesToBlocklist([tosImage(CSAM_HASH), tosImage(OTHER)]);

    expect(ch.inserts).toHaveLength(1);
    expect(ch.inserts[0].values).toEqual([{ hash: OTHER, reason: expect.any(String) }]);
  });

  it('a CSAM block still lands on it', async () => {
    await addImagesToBlocklist([{ ...tosImage(CSAM_HASH), csam: true }]);

    expect(ch.inserts[0]?.values).toEqual([{ hash: CSAM_HASH, reason: 'CSAM' }]);
  });
});
