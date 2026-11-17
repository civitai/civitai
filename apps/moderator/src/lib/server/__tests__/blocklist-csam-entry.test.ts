import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * blocked_images keeps the newest row per hash when it merges, so any later row over a hash with a
 * CSAM entry replaces that entry. Neither a block of another reason nor an unblock may write one.
 */

const ch = vi.hoisted(() => ({
  inserts: [] as { table: string; values: unknown[] }[],
  queries: [] as string[],
  liveRows: [] as { hash: string; reason: string }[],
  csamHashes: [] as string[],
  lookupFails: false,
  // Rows oldest first. FINAL reads what a merge keeps, the newest row per hash; without it every
  // row is read, merged or not.
  tableRows: undefined as { hash: string; reason: string; disabled: boolean }[] | undefined,
}));

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/notifications', () => ({ getNotifications: () => ({}) }));
const logToAxiom = vi.hoisted(() => vi.fn());
vi.mock('../axiom', () => ({ logToAxiom, logAxiomError: vi.fn() }));
vi.mock('$lib/server/clickhouse', () => ({
  getClickhouse: () => ({
    query: async ({ query }: { query: string }) => {
      ch.queries.push(query);
      if (!query.includes("reason = 'CSAM'")) return { json: async () => ch.liveRows };
      if (ch.lookupFails) throw new Error('Socket hang up');
      if (ch.tableRows) {
        const rows = query.includes(' FINAL ')
          ? [...new Map(ch.tableRows.map((row) => [row.hash, row])).values()]
          : ch.tableRows;
        const live = rows.filter((row) => row.reason === 'CSAM' && !row.disabled);
        return {
          json: async () => [...new Set(live.map((row) => row.hash))].map((hash) => ({ hash })),
        };
      }
      return { json: async () => ch.csamHashes.map((hash) => ({ hash })) };
    },
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
  ch.queries = [];
  ch.liveRows = [];
  ch.csamHashes = [CSAM_HASH];
  ch.lookupFails = false;
  ch.tableRows = undefined;
  logToAxiom.mockClear();
});

// Deliberately a SQL-text assertion: a server setting's effect cannot be shown by the fake. With
// the setting on, the reason/disabled filters may run in PREWHERE, before FINAL merges, and an
// older live CSAM row would count again. Ruled to be pinned on the query; keep this.
it('pins the setting that keeps the CSAM filters after the FINAL merge', async () => {
  await addImagesToBlocklist([tosImage(CSAM_HASH)]);

  const lookup = ch.queries.find((query) => query.includes("reason = 'CSAM'"));
  expect(lookup).toContain('SETTINGS optimize_move_to_prewhere_if_final = 0');
});

it('a CSAM row a newer, unmerged row disabled is not live, so another block lands', async () => {
  ch.tableRows = [
    { hash: CSAM_HASH, reason: 'CSAM', disabled: false },
    { hash: CSAM_HASH, reason: 'CSAM', disabled: true },
  ];

  await addImagesToBlocklist([tosImage(CSAM_HASH)]);

  expect(ch.inserts.map(({ values }) => values)).toEqual([
    [{ hash: CSAM_HASH, reason: expect.any(String) }],
  ]);
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

  it('a failed lookup refuses the unblock: nothing is disabled and the refusal is logged', async () => {
    ch.lookupFails = true;
    ch.liveRows = [{ hash: OTHER, reason: 'TOS' }];

    await expect(
      removeImagesFromBlocklist([OTHER], { step: 'unblock', imageId: 9, actorUserId: 2 })
    ).resolves.toBeUndefined();
    expect(ch.inserts).toEqual([]);
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        name: 'blocklist-disable-refused',
        payload: expect.objectContaining({
          step: 'unblock',
          imageId: 9,
          actorUserId: 2,
          hashes: [OTHER],
        }),
      })
    );
  });

  it('a failed lookup leaves the other block unwritten and logged, after the CSAM row lands', async () => {
    ch.lookupFails = true;

    await expect(
      addImagesToBlocklist([{ ...tosImage(CSAM_HASH), csam: true }, tosImage(OTHER)], {
        step: 'block',
        imageId: 9,
        actorUserId: 2,
      })
    ).resolves.toBeUndefined();
    expect(ch.inserts.map((i) => i.values)).toEqual([[{ hash: CSAM_HASH, reason: 'CSAM' }]]);
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        name: 'blocklist-insert-skipped',
        payload: expect.objectContaining({
          step: 'block',
          imageId: 9,
          actorUserId: 2,
          hashes: [OTHER],
        }),
      })
    );
  });

  it('a row in the same batch as a CSAM row for its hash is not written', async () => {
    ch.csamHashes = [];

    await addImagesToBlocklist([{ ...tosImage(OTHER), csam: true }, tosImage(OTHER)]);

    expect(ch.inserts.map((i) => i.values)).toEqual([[{ hash: OTHER, reason: 'CSAM' }]]);
  });
});
