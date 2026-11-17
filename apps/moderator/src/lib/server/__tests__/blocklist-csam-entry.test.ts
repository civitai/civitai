import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * blocked_images keeps the newest row per hash when it merges, so any later row over a hash with a
 * CSAM entry replaces that entry. Neither a block of another reason nor an unblock may write one.
 */

const ch = vi.hoisted(() => ({
  inserts: [] as { table: string; values: unknown[] }[],
  liveRows: [] as { hash: string; reason: string }[],
  csamHashes: [] as string[],
  lookupFails: false,
}));

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/notifications', () => ({ getNotifications: () => ({}) }));
vi.mock('$lib/server/clickhouse', () => ({
  getClickhouse: () => ({
    query: async ({ query }: { query: string }) => {
      if (!query.includes("reason = 'CSAM'")) return { json: async () => ch.liveRows };
      if (ch.lookupFails) throw new Error('Socket hang up');
      return { json: async () => ch.csamHashes.map((hash) => ({ hash })) };
    },
    insert: async ({ table, values }: { table: string; values: unknown[] }) => {
      ch.inserts.push({ table, values });
    },
  }),
}));

const { addImagesToBlocklist, removeImagesFromBlocklist, BlocklistCheckError } = await import(
  '../image-moderation-effects'
);

const CSAM_HASH = '-4276845791567733103';
const OTHER = '1234567890123';
const tosImage = (pHash: string) => ({ pHash, needsReview: null, blockedFor: 'moderated' });

beforeEach(() => {
  ch.inserts = [];
  ch.liveRows = [];
  ch.csamHashes = [CSAM_HASH];
  ch.lookupFails = false;
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

  it('a failed lookup refuses the unblock: it throws and disables nothing', async () => {
    ch.lookupFails = true;
    ch.liveRows = [{ hash: OTHER, reason: 'TOS' }];

    await expect(removeImagesFromBlocklist([OTHER])).rejects.toBeInstanceOf(BlocklistCheckError);
    expect(ch.inserts).toEqual([]);
  });

  it('a failed lookup throws the other block unwritten, after the CSAM row lands', async () => {
    ch.lookupFails = true;

    await expect(
      addImagesToBlocklist([{ ...tosImage(CSAM_HASH), csam: true }, tosImage(OTHER)])
    ).rejects.toBeInstanceOf(BlocklistCheckError);
    expect(ch.inserts.map((i) => i.values)).toEqual([[{ hash: CSAM_HASH, reason: 'CSAM' }]]);
  });

  it('a row in the same batch as a CSAM row for its hash is not written', async () => {
    ch.csamHashes = [];

    await addImagesToBlocklist([{ ...tosImage(OTHER), csam: true }, tosImage(OTHER)]);

    expect(ch.inserts.map((i) => i.values)).toEqual([[{ hash: OTHER, reason: 'CSAM' }]]);
  });
});
