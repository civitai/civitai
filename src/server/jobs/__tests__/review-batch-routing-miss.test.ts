import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import type * as ReviewBatchService from '~/server/services/review-batch/review-batch.service';

/**
 * The daily routing-miss check: a general-tier view whose image carries a signal now is recorded
 * once, as append-only rows with no signal names, and every run writes its dated heartbeat. The
 * signal reads are faked; the SQL the job sends is captured as text.
 */

const { mockReadSignals, mockReadScanner } = vi.hoisted(() => ({
  mockReadSignals: vi.fn(),
  mockReadScanner: vi.fn(),
}));
vi.mock('~/server/services/review-batch/review-batch.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ReviewBatchService>()),
  readImageSignals: mockReadSignals,
  readScannerHits: mockReadScanner,
}));

const { checkReviewBatchRoutingMisses, ROUTING_MISS_ACTIVITY, MISS_CHECK_ACTIVITY } = await import(
  '../review-batch-routing-miss'
);

type Sql = { strings: readonly string[]; values: unknown[] };
const sqlText = ({ strings }: Sql) => strings.join('?');
const isSql = (v: unknown): v is Sql => !!v && typeof v === 'object' && 'strings' in v;
/** The statement as sent, nested `Prisma.sql` fragments included, each bound value inlined. */
const render = ({ strings, values }: Sql): string =>
  strings.reduce((out, part, i) => {
    if (i === 0) return part;
    const v = values[i - 1];
    return out + (isSql(v) ? render(v) : JSON.stringify(v)) + part;
  }, '');
/** Each VALUES tuple of an insert, literals and bound values alike. */
const tuples = (text: string) =>
  [...text.slice(text.indexOf('VALUES')).matchAll(/\(([^()]*)\)/g)].map(([, inner]) =>
    [...inner.matchAll(/'([^']*)'|"([^"]*)"|(-?\d+)/g)].map(([, lit, str, num]) =>
      num !== undefined ? Number(num) : lit ?? str
    )
  );

let served: { imageId: number; batchHash: string }[] = [];
let recorded: { imageId: number; batchHash: string }[] = [];
let reports: { id: number }[] = [];
let inserts: string[] = [];

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
      inserts.push(render({ strings, values }));
      return 1;
    }
  );
});

const missRows = () => inserts.flatMap(tuples).filter((t) => t.includes(ROUTING_MISS_ACTIVITY));
const heartbeats = () => inserts.flatMap(tuples).filter((t) => t.includes(MISS_CHECK_ACTIVITY));
const imageMiss = (id: number, hash: string) => [
  -1,
  'image',
  id,
  ROUTING_MISS_ACTIVITY,
  hash,
  'general',
];

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
    expect(missRows()).toEqual([imageMiss(1, 'h1')]);
    expect(heartbeats()).toEqual([[-1, 'reviewBatchMissCheck', 20261114, MISS_CHECK_ACTIVITY]]);
  });

  it('a miss already recorded for that image and batch is not recorded again', async () => {
    served = [{ imageId: 1, batchHash: 'h1' }];
    recorded = [{ imageId: 1, batchHash: 'h1' }];
    mockReadSignals.mockResolvedValue(new Map([[1, row(1, { suspect: true })]]));
    expect((await checkReviewBatchRoutingMisses()).misses).toBe(0);
    expect(missRows()).toHaveLength(0);
    expect(heartbeats()).toHaveLength(1);
  });

  it('a scanner-only label counts, and the image report goes on its own csamReport row', async () => {
    served = [{ imageId: 3, batchHash: 'h3' }];
    reports = [{ id: 77 }];
    mockReadSignals.mockResolvedValue(new Map([[3, row(3)]]));
    mockReadScanner.mockResolvedValue(new Set([3]));
    expect((await checkReviewBatchRoutingMisses()).misses).toBe(1);
    expect(missRows()).toEqual([
      imageMiss(3, 'h3'),
      [-1, 'csamReport', 77, ROUTING_MISS_ACTIVITY, 'h3', 'general'],
    ]);
  });

  it('nothing served still writes the heartbeat, with count 0', async () => {
    expect(await checkReviewBatchRoutingMisses()).toMatchObject({ served: 0, misses: 0 });
    expect(heartbeats()).toHaveLength(1);
    expect(mockReadSignals).not.toHaveBeenCalled();
  });

  it('writes only ModActivity rows of fixed columns, never the signal behind the miss', async () => {
    served = [{ imageId: 1, batchHash: 'h1' }];
    reports = [{ id: 5 }];
    mockReadSignals.mockResolvedValue(new Map([[1, row(1, { blockedFor: 'sig' })]]));
    await checkReviewBatchRoutingMisses();
    for (const text of inserts) expect(text.trimStart()).toMatch(/^INSERT INTO "ModActivity" /);
    expect(missRows()).toEqual([
      imageMiss(1, 'h1'),
      [-1, 'csamReport', 5, ROUTING_MISS_ACTIVITY, 'h1', 'general'],
    ]);
    expect(inserts.join('\n')).not.toMatch(/\bsig\b/);
  });
});

describe('what is not a miss', () => {
  it('a scan gone back to pending, or an image with no scanner rows, is not recorded', async () => {
    served = [
      { imageId: 4, batchHash: 'h4' },
      { imageId: 5, batchHash: 'h4' },
    ];
    mockReadSignals.mockResolvedValue(
      new Map([
        [4, row(4, { unreadable: true })],
        [5, row(5)],
      ])
    );
    expect((await checkReviewBatchRoutingMisses()).misses).toBe(0);
    expect(mockReadScanner).toHaveBeenCalledWith([4, 5], { absentHolds: false });
    expect(missRows()).toHaveLength(0);
  });
});
