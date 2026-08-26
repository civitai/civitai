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

function makeRow(id: number, entityType: string, materializedAt: number): FakeRow {
  return {
    blurbId: id,
    entityType,
    entityId: id,
    materializedHash: 'old',
    id,
    content: 'NEW',
    contentHash: 'new',
    deletedAt: null,
    materializedAt,
  };
}

let table: FakeRow[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  table = [];
  // `entityId` and `blurbId` are the same value in the fake table (see `makeRow`), so a
  // span tagged with the loaded entityId always matches the blurb being processed and a
  // supported row always has something real to rewrite.
  adapter.load.mockImplementation(async (entityId: number) => ({
    userId: 10,
    html: `<span data-type="blurb" data-id="${entityId}">OLD</span>`,
  }));
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
});

describe('runBlurbFanout — selector', () => {
  it('excludes references whose entity type has no adapter', async () => {
    table = [makeRow(1, 'Unsupported', 1), makeRow(2, 'Article', 2)];

    await runBlurbFanout({ limit: 5 });

    // Only the supported row ever reaches the adapter — proves the unsupported one
    // never entered the processing loop at all.
    expect(adapter.load).toHaveBeenCalledTimes(1);
    expect(adapter.load).toHaveBeenCalledWith(2);
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
    table = [
      makeRow(1, 'Unsupported', 1),
      makeRow(2, 'Unsupported', 2),
      makeRow(3, 'Article', 3),
    ];

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
      if (args.entityId === 1) throw new Error('blocked domain');
    });

    table = [makeRow(1, 'Article', 1), makeRow(2, 'Article', 2)];

    const result = await runBlurbFanout({ limit: 5 });

    expect(result.failed).toBe(1);
    expect(result.rewritten).toBe(1);
    // Both rows were attempted — row 2 was never skipped because row 1 threw.
    expect(adapter.load).toHaveBeenCalledWith(1);
    expect(adapter.load).toHaveBeenCalledWith(2);
  });

  it("advances the failing row's materializedAt, so it doesn't head the next window", async () => {
    adapter.save.mockImplementation(async () => {
      throw new Error('blocked domain');
    });

    table = [makeRow(1, 'Article', 1)];

    await runBlurbFanout({ limit: 5 });

    const call = dbMock.dbWrite.blurbReference.update.mock.calls[0][0];
    expect(call.where).toEqual({
      blurbId_entityType_entityId: { blurbId: 1, entityType: 'Article', entityId: 1 },
    });
    expect(call.data.materializedAt).toBeInstanceOf(Date);
    // Never the hash — the row's content was never actually applied.
    expect(call.data.materializedHash).toBeUndefined();
  });
});
