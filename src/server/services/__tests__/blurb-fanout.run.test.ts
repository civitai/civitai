import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// `runBlurbFanout`'s own regression suite: unsupported entityTypes must be excluded from
// the selector rather than discarded per-row, or enough of them starve the whole batch (see
// blurb-fanout.service.ts). The adapters module is mocked at the boundary the service uses —
// only `Article` is "registered" — so the fake `$queryRaw` below can honour the same
// entityType filter the real SQL applies, without a live database.
const adapter = { load: vi.fn(), save: vi.fn() };
const SUPPORTED = ['Article'];

vi.mock('~/server/services/blurb-fanout.adapters', () => ({
  getBlurbFanoutAdapter: (entityType: string) => (entityType === 'Article' ? adapter : undefined),
  getSupportedBlurbEntityTypes: () => SUPPORTED,
}));

const { runBlurbFanout } = await import('~/server/services/blurb-fanout.service');

type FakeRow = {
  blurbId: number;
  entityType: string;
  entityId: number;
  materializedHash: string;
  id: number;
  content: string;
  contentHash: string;
  deletedAt: Date | null;
  materializedAt: number; // fake-table ordering only, not part of the real SELECT list
};

// `entityId` is deliberately NOT `blurbId`: they were the same value here, which made every
// fake row its own entity and hid the lost-update the per-entity batching exists to stop.
function makeRow(
  id: number,
  entityType: string,
  materializedAt: number,
  entityId = id * 100
): FakeRow {
  return {
    blurbId: id,
    entityType,
    entityId,
    materializedHash: 'old',
    id,
    content: `NEW-${id}`,
    contentHash: `new-${id}`,
    deletedAt: null,
    materializedAt,
  };
}

let table: FakeRow[] = [];
/** Per-entity html, for a test that needs a body the default builder can't express. */
let entityBodies = new Map<number, string>();

beforeEach(() => {
  vi.clearAllMocks();
  table = [];
  entityBodies = new Map();
  // Serves a body carrying a span for every blurb that references this entity, so a supported
  // row always has something real to rewrite and a two-blurb entity can be observed losing one.
  adapter.load.mockImplementation(async (entityId: number) =>
    entityBodies.has(entityId)
      ? { userId: 10, html: entityBodies.get(entityId) as string }
      : {
          userId: 10,
          html: table
            .filter((r) => r.entityId === entityId)
            .map((r) => `<span data-type="blurb" data-id="${r.blurbId}">OLD-${r.blurbId}</span>`)
            .join(''),
        }
  );
  adapter.save.mockResolvedValue(undefined);

  // Stands in for Postgres: filters by the same `entityType = ANY(...)` argument the real
  // query interpolates, so a fake-table scenario exercises the real filtering CONTRACT
  // (what value gets threaded through) rather than the SQL text, which no unit test here
  // can execute. Bounded by `table`'s own (small, fixed) size, so it terminates immediately
  // — never a source of a hanging loop.
  dbMock.dbRead.$queryRaw.mockImplementation(async (..._args: unknown[]) => {
    const [, supported, limit] = _args as [unknown, string[], number | undefined];
    const filtered = table.filter((r) => supported.includes(r.entityType));
    if (limit === undefined) {
      return [{ count: table.length - filtered.length }];
    }
    return [...filtered].sort((a, b) => a.materializedAt - b.materializedAt).slice(0, limit);
  });

  // Makes the fake table honour recordReference/recordFailure's writes, so a test can
  // re-run the selector afterwards and observe the reordering those writes are FOR — not
  // just assert the write's shape.
  dbMock.dbWrite.blurbReference.update.mockImplementation(async (args: any) => {
    const key = args.where.blurbId_entityType_entityId;
    const row = table.find(
      (r) =>
        r.blurbId === key.blurbId && r.entityType === key.entityType && r.entityId === key.entityId
    );
    if (!row) return undefined;
    if (args.data.materializedAt instanceof Date)
      row.materializedAt = args.data.materializedAt.getTime();
    if (typeof args.data.materializedHash === 'string')
      row.materializedHash = args.data.materializedHash;
    return undefined;
  });
});

describe('runBlurbFanout — selector', () => {
  it('excludes references whose entity type has no adapter', async () => {
    table = [makeRow(1, 'Unsupported', 1), makeRow(2, 'Article', 2)];

    await runBlurbFanout({ limit: 5 });

    // Only the supported row ever reaches the adapter — proves the unsupported one
    // never entered the processing loop at all.
    expect(adapter.load).toHaveBeenCalledTimes(1);
    expect(adapter.load).toHaveBeenCalledWith(200);
  });
});

describe('runBlurbFanout — starvation regression', () => {
  it('still processes a supported reference behind many unsupported ones', async () => {
    // Five unsupported rows sort ahead of the one supported row. With `limit: 5` — smaller
    // than the real BATCH_LIMIT, so this fails fast rather than needing 500 rows — a
    // selector that let unsupported rows occupy the window would return only those five
    // and never reach the supported one.
    table = [
      makeRow(1, 'Unsupported', 1),
      makeRow(2, 'Unsupported', 2),
      makeRow(3, 'Unsupported', 3),
      makeRow(4, 'Unsupported', 4),
      makeRow(5, 'Unsupported', 5),
      makeRow(6, 'Article', 6),
    ];

    const result = await runBlurbFanout({ limit: 5 });

    expect(adapter.save).toHaveBeenCalledTimes(1);
    expect(result.rewritten).toBe(1);
  });
});

describe('runBlurbFanout — unsupported count', () => {
  it('still reports how many references are stuck on an unsupported entity type', async () => {
    table = [makeRow(1, 'Unsupported', 1), makeRow(2, 'Unsupported', 2), makeRow(3, 'Article', 3)];

    const result = await runBlurbFanout({ limit: 5 });

    expect(result.unsupportedBacklog).toBe(2);
  });

  it('reports zero when every reference has a registered adapter', async () => {
    table = [makeRow(1, 'Article', 1)];

    const result = await runBlurbFanout({ limit: 5 });

    expect(result.unsupportedBacklog).toBe(0);
  });

  it('reports null and skips the query when the caller opts out', async () => {
    table = [makeRow(1, 'Unsupported', 1)];

    const result = await runBlurbFanout({ limit: 5, includeUnsupportedBacklog: false });

    expect(result.unsupportedBacklog).toBeNull();
    // Only the selector call — the count query never ran.
    expect(dbMock.dbRead.$queryRaw).toHaveBeenCalledTimes(1);
  });
});

describe('runBlurbFanout — a failing row cannot wedge the batch', () => {
  it('keeps processing the rest of the batch after one row throws, and counts the failure', async () => {
    // Simulates Task 6's blocked-link-domain guard (or any other adapter.save failure)
    // tripping on one specific row, mid-batch.
    adapter.save.mockImplementation(async (args: { entityId: number }) => {
      if (args.entityId === 100) throw new Error('blocked domain');
    });

    table = [makeRow(1, 'Article', 1), makeRow(2, 'Article', 2)];

    const result = await runBlurbFanout({ limit: 5 });

    expect(result.failed).toBe(1);
    expect(result.rewritten).toBe(1);
    // Both rows were attempted — row 2 was never skipped because row 1 threw.
    expect(adapter.load).toHaveBeenCalledWith(100);
    expect(adapter.load).toHaveBeenCalledWith(200);
  });

  it("advances the failing row's materializedAt, so it doesn't head the next window", async () => {
    adapter.save.mockImplementation(async () => {
      throw new Error('blocked domain');
    });

    table = [makeRow(1, 'Article', 1)];

    await runBlurbFanout({ limit: 5 });

    const call = dbMock.dbWrite.blurbReference.update.mock.calls[0][0];
    expect(call.where).toEqual({
      blurbId_entityType_entityId: { blurbId: 1, entityType: 'Article', entityId: 100 },
    });
    expect(call.data.materializedAt).toBeInstanceOf(Date);
    // Never the hash — the row's content was never actually applied.
    expect(call.data.materializedHash).toBeUndefined();
  });

  it('moves a failing row behind others, so a later pass reaches what it was blocking', async () => {
    // Row 1 fails every time and starts at the FRONT of the queue (oldest materializedAt).
    // Row 2 is genuinely stale and starts right behind it. With `limit: 1`, a selector that
    // never re-sorted the failing row would starve row 2 forever — this is the property
    // recordFailure's materializedAt bump exists for, asserted end-to-end via a second pass
    // rather than just the shape of the write.
    adapter.save.mockImplementation(async (args: { entityId: number }) => {
      if (args.entityId === 100) throw new Error('blocked domain');
    });
    table = [makeRow(1, 'Article', 1), makeRow(2, 'Article', 2)];

    const first = await runBlurbFanout({ limit: 1 });
    expect(first.failed).toBe(1);
    expect(adapter.save).toHaveBeenCalledTimes(1);

    adapter.save.mockClear();
    adapter.load.mockClear();

    const second = await runBlurbFanout({ limit: 1 });

    // recordFailure's write (via the update mock's fake-table mutation set up in
    // beforeEach) pushed row 1's materializedAt past row 2's, so row 2 — not row 1 again —
    // is what this pass reaches.
    expect(adapter.load).toHaveBeenCalledWith(200);
    expect(adapter.load).not.toHaveBeenCalledWith(100);
    expect(second.rewritten).toBe(1);
  });
});

describe('runBlurbFanout — two stale blurbs on one entity', () => {
  it('🔴 applies both after a single pass', async () => {
    // Both were edited in one manager session, so reconcileBlurbReferences stamped them from one
    // `now` and they sort adjacently into the same window. Processed per reference, each task
    // loaded the same body, spliced in only its own blurb and saved the whole thing — one update
    // won, the other was discarded, and both rows were stamped current so nothing retried it.
    const ENTITY = 500;
    table = [makeRow(1, 'Article', 1, ENTITY), makeRow(2, 'Article', 1, ENTITY)];

    const result = await runBlurbFanout({ limit: 5 });

    expect(adapter.save).toHaveBeenCalledTimes(1);
    expect(adapter.save.mock.calls[0][0].html).toBe(
      '<span data-type="blurb" data-id="1">NEW-1</span>' +
        '<span data-type="blurb" data-id="2">NEW-2</span>'
    );
    expect(result.rewritten).toBe(2);

    // And both rows are stamped current. That half was already true of the broken version — it is
    // what made the lost edit permanent — so it only means anything next to the html above.
    expect(
      dbMock.dbWrite.blurbReference.updateMany.mock.calls.map(([arg]) => [
        arg.where.blurbId.in,
        arg.data.materializedHash,
      ])
    ).toEqual([
      [[1], 'new-1'],
      [[2], 'new-2'],
    ]);
  });
});
