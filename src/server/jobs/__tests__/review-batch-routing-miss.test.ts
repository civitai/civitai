import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';

/**
 * The daily routing-miss check: a general-tier view whose image carries a signal now is recorded
 * once, as append-only rows with no signal names, and every run writes its dated heartbeat. The
 * signal reads are faked; the SQL the job sends is captured as text.
 */

const { mockReadSignals, mockReadScanner } = vi.hoisted(() => ({
  mockReadSignals: vi.fn(),
  mockReadScanner: vi.fn(),
}));
vi.mock('~/server/services/review-batch/review-batch.service', () => ({
  readImageSignals: mockReadSignals,
  readScannerHits: mockReadScanner,
}));

const { checkReviewBatchRoutingMisses, ROUTING_MISS_ACTIVITY, MISS_CHECK_ACTIVITY } = await import(
  '../review-batch-routing-miss'
);

type Sql = { strings: readonly string[]; values: unknown[] };
const sqlText = ({ strings }: Sql) => strings.join('?');
/** A nested `Prisma.sql` fragment arrives as one value; its own values are what the row holds. */
const flat = (values: unknown[]): unknown[] =>
  values.flatMap((v) =>
    v && typeof v === 'object' && 'values' in v ? flat((v as { values: unknown[] }).values) : [v]
  );

let served: { imageId: number; batchHash: string }[] = [];
let recorded: { imageId: number; batchHash: string }[] = [];
let reports: { id: number }[] = [];
let inserts: Sql[] = [];

const row = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  suspect: false,
  unreadable: false,
  blockedFor: null,
  ...over,
});

beforeEach(() => {
  setEnv({ REVIEW_SHEET_BLOCKEDFOR_PATTERNS: '# signal\n^sig$\n# known-non-minor\n^benign$' });
  served = [];
  recorded = [];
  reports = [];
  inserts = [];
  mockReadSignals.mockReset();
  mockReadScanner.mockReset().mockResolvedValue(new Set());
  dbMock.dbWrite.$queryRaw.mockImplementation(
    async (strings: readonly string[], ...values: unknown[]) => {
      const text = sqlText({ strings, values });
      if (text.includes('"reviewTier" = \'general\'')) return served;
      if (text.includes('FROM "CsamReport"')) return reports;
      if (text.includes('FROM "ModActivity"')) return recorded;
      throw new Error(`unexpected query: ${text}`);
    }
  );
  dbMock.dbWrite.$executeRaw.mockImplementation(
    async (strings: readonly string[], ...values: unknown[]) => {
      inserts.push({ strings, values: flat(values) });
      return 1;
    }
  );
});

const missRows = () => inserts.filter((i) => i.values.includes(ROUTING_MISS_ACTIVITY));
const heartbeats = () => inserts.filter((i) => i.values.includes(MISS_CHECK_ACTIVITY));

describe('the routing-miss check', () => {
  it('records a served general image that now carries a signal, once, and writes the heartbeat', async () => {
    served = [
      { imageId: 1, batchHash: 'h1' },
      { imageId: 2, batchHash: 'h1' },
    ];
    mockReadSignals.mockResolvedValue(
      new Map([
        [1, row(1, { suspect: true })],
        [2, row(2)],
      ])
    );
    const result = await checkReviewBatchRoutingMisses(new Date('2026-11-14T07:23:00Z'));
    expect(result).toMatchObject({ served: 2, misses: 1 });
    expect(missRows()).toHaveLength(1);
    expect(missRows()[0].values).toEqual(expect.arrayContaining([1, 'h1']));
    expect(heartbeats()).toHaveLength(1);
    expect(heartbeats()[0].values).toContain(20261114);
  });

  it('a miss already recorded for that image and batch is not recorded again', async () => {
    served = [{ imageId: 1, batchHash: 'h1' }];
    recorded = [{ imageId: 1, batchHash: 'h1' }];
    mockReadSignals.mockResolvedValue(new Map([[1, row(1, { suspect: true })]]));
    expect((await checkReviewBatchRoutingMisses()).misses).toBe(0);
    expect(missRows()).toHaveLength(0);
    expect(heartbeats()).toHaveLength(1);
  });

  it('a scanner-only label counts, and the image report id goes on its own row', async () => {
    served = [{ imageId: 3, batchHash: 'h3' }];
    reports = [{ id: 77 }];
    mockReadSignals.mockResolvedValue(new Map([[3, row(3)]]));
    mockReadScanner.mockResolvedValue(new Set([3]));
    expect((await checkReviewBatchRoutingMisses()).misses).toBe(1);
    const [insert] = missRows();
    expect(insert.values).toEqual(expect.arrayContaining([3, 77, 'h3']));
  });

  it('nothing served still writes the heartbeat, with count 0', async () => {
    expect(await checkReviewBatchRoutingMisses()).toMatchObject({ served: 0, misses: 0 });
    expect(heartbeats()).toHaveLength(1);
    expect(mockReadSignals).not.toHaveBeenCalled();
  });

  it('writes no signal name and never touches CsamReport', async () => {
    served = [{ imageId: 1, batchHash: 'h1' }];
    reports = [{ id: 5 }];
    mockReadSignals.mockResolvedValue(new Map([[1, row(1, { blockedFor: 'sig' })]]));
    await checkReviewBatchRoutingMisses();
    const written = inserts.map((i) => sqlText(i) + JSON.stringify(i.values)).join('\n');
    expect(written).not.toMatch(/"CsamReport"/);
    expect(written).not.toMatch(/\bsig\b|minor|csam/i);
  });
});
