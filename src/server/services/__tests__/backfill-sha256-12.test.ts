import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * `/api/admin/temp/backfill-sha256-12` — the one-time backfill that gives files scanned before
 * `normalizeScanHashes()` shipped their missing `SHA256_12` row.
 *
 * It is the fourth `ModelFileHash` writer (ledger: model-file-hash-writers.test.ts). The ledger
 * is structural — it proves the endpoint CALLS the helper. It cannot prove the endpoint uses
 * what the helper returns, that it stops where it was told to stop, or that a second run is
 * free. Those are the four hazards below, and each is asserted behaviourally:
 *
 *   1. derivation      writes sha256[0:12] — a value present nowhere in the input
 *   2. sentinel        the all-zero "file unreachable" SHA256 gets NO derived row
 *   3. idempotency     a second run over covered ground inserts nothing
 *   4. bounds/cursor   maxBatches stops the walk and reports a resumable cursor
 *
 * The write fake below enforces the real `ModelFileHash_pkey` on `("fileId", type)`: inserting a
 * pair that already exists throws unless `skipDuplicates` is set. So hazard 3 is a property of
 * the endpoint's call, not of a `mockResolvedValue({ count: 0 })` that would pass for an
 * endpoint with no conflict handling at all.
 */

// The endpoint imports the real model-file-scan.service for normalizeScanHashes. That module's
// import graph reaches clickhouse/redis/search-index/flipt at load time; stub the edges so the
// helper under test is the only real code in the path. (Same surface as
// reprocess-scan-hash-derivation.test.ts, which drives the same service for the same reason.)
vi.mock('@civitai/client', () => ({
  getWorkflow: vi.fn(),
  submitWorkflow: vi.fn(),
  createCivitaiClient: vi.fn(),
  WorkflowStatus: { Pending: 'Pending', Running: 'Running', Completed: 'Completed' },
  TimeSpan: { fromDays: vi.fn(), fromHours: vi.fn() },
}));
vi.mock('~/server/services/orchestrator/client', () => ({ internalOrchestratorClient: {} }));
vi.mock('~/server/redis/caches', () => ({ dataForModelsCache: { refresh: vi.fn() } }));
vi.mock('~/server/search-index', () => ({ modelsSearchIndex: { queueUpdate: vi.fn() } }));
vi.mock('~/server/services/model-file.service', () => ({
  deleteFilesForModelVersionCache: vi.fn(),
  findOfficialFileByHash: vi.fn(),
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/orchestrator/orchestrator.service', () => ({
  createModelFileScanRequest: vi.fn(),
  ModelFileScanSubmissionError: class extends Error {},
}));
vi.mock('~/server/utils/concurrency-helpers', () => ({ limitConcurrency: vi.fn() }));
vi.mock('~/server/services/model.service', () => ({ unpublishModelById: vi.fn() }));
vi.mock('~/server/services/model-version.service', () => ({ addLinkedComponent: vi.fn() }));
vi.mock('~/server/services/minor-hash.service', () => ({
  checkMinorHashOnScan: vi.fn(),
  MINOR_HASH_FILE_TYPE: 'Model',
}));
vi.mock('~/server/flipt/client', () => ({
  isFlipt: vi.fn().mockResolvedValue(true),
  FLIPT_FEATURE_FLAGS: { MINOR_HASH_AUTO_FLAG: 'minor-hash-auto-flag' },
}));

// WebhookEndpoint wraps the handler in a WEBHOOK_TOKEN check. Unwrap it — this file is about the
// rows written, and token auth is covered by the endpoint-helpers tests. `handleEndpointError` is
// the shared 500 chokepoint (civitai#3845); spy on it so the failure path can be asserted without
// reimplementing its genericization here.
const helperMocks = vi.hoisted(() => ({ handleEndpointError: vi.fn() }));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: (req: NextApiRequest, res: NextApiResponse) => unknown) => handler,
  handleEndpointError: helperMocks.handleEndpointError,
}));

import handler from '~/pages/api/admin/temp/backfill-sha256-12';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Pairwise distinct, and distinct from every constant the assertions name (12, 10, the all-zero
// sentinel, and every fileId), so a mutant that truncates to the wrong width, hardcodes a literal
// prefix, or copies one file's hash onto another's row cannot land on an expected value by
// accident. Two DIFFERENT hashes is the control that kills a hardcoded-literal mutant: it can
// only ever match one of them.
const HASH_A = '1a2b3c4d5e6f7081'.repeat(4); // 64 chars; [0:12] = '1a2b3c4d5e6f'
const HASH_B = '9f8e7d6c5b4a3928'.repeat(4); // 64 chars; [0:12] = '9f8e7d6c5b4a'
const HASH_C = 'c0ffee1234567890'.repeat(4); // 64 chars; [0:12] = 'c0ffee123456'
const SENTINEL = '0'.repeat(64);

const PREFIX_A = '1a2b3c4d5e6f';
const PREFIX_B = '9f8e7d6c5b4a';
const PREFIX_C = 'c0ffee123456';

// fileIds are non-contiguous and share no digits with any prefix, so a cursor assertion cannot be
// satisfied by an off-by-one that happens to land on the next fixture.
const FILE_A = 101;
const FILE_B = 205;
const FILE_C = 317;

type Row = { fileId: number; hash: string };

/** Rows the fake `createMany` has accepted, keyed like the real PK: `<fileId>:<type>`. */
let storedKeys: Set<string>;
/** Every row handed to `createMany`, flattened, in call order. */
let insertAttempts: { fileId: number; type: string; hash: string }[];

/**
 * Installs an in-memory corpus behind `dbRead.modelFileHash.findMany`, branching on the `type`
 * the endpoint asks for — SHA256 pages the walk, SHA256_12 answers the dry-run coverage lookup.
 * A single blanket mock would let a dry run read its own candidate list as "already covered".
 */
function installCorpus(sha256Rows: Row[], alreadyCovered: number[] = []) {
  for (const fileId of alreadyCovered) storedKeys.add(`${fileId}:SHA256_12`);

  dbMock.dbRead.modelFileHash.findMany.mockImplementation(async (args: any) => {
    if (args.where.type === 'SHA256_12') {
      const ids: number[] = args.where.fileId.in;
      return ids.filter((id) => storedKeys.has(`${id}:SHA256_12`)).map((fileId) => ({ fileId }));
    }
    const gte = args.where.fileId.gte ?? 0;
    const lte = args.where.fileId.lte ?? Number.POSITIVE_INFINITY;
    return sha256Rows
      .filter((r) => r.fileId >= gte && r.fileId <= lte)
      .sort((a, b) => a.fileId - b.fileId)
      .slice(0, args.take)
      .map((r) => ({ fileId: r.fileId, hash: r.hash }));
  });
}

const runHandler = async (query: Record<string, string> = {}) => {
  const req = { method: 'GET', query } as unknown as NextApiRequest;
  const json = vi.fn().mockReturnThis();
  const status = vi.fn().mockReturnThis();
  const res = { status, json } as unknown as NextApiResponse;
  await handler(req, res);
  const body = json.mock.calls.at(-1)?.[0] as any;
  expect(body, 'the endpoint never responded').toBeDefined();
  // A 500 carries `ok: false` and an `error`; surface it instead of failing on a missing field.
  expect(body.error, `endpoint errored: ${body.error}`).toBeUndefined();
  return body;
};

/** `<fileId>=<hash>` for every row handed to createMany, sorted. */
const rowsWritten = () =>
  insertAttempts.map(({ fileId, type, hash }) => `${fileId}:${type}=${hash}`).sort();

beforeEach(() => {
  vi.clearAllMocks();
  storedKeys = new Set();
  insertAttempts = [];

  // Enforces the real `ModelFileHash_pkey` on ("fileId", type). Without `skipDuplicates` a
  // repeat insert throws, exactly as Postgres would — which is what makes the idempotency test
  // an assertion about the endpoint rather than about this fake.
  dbMock.dbWrite.modelFileHash.createMany.mockImplementation(async (args: any) => {
    const { data, skipDuplicates } = args;
    let count = 0;
    for (const row of data) {
      insertAttempts.push(row);
      const key = `${row.fileId}:${row.type}`;
      if (storedKeys.has(key)) {
        if (!skipDuplicates) {
          throw new Error(
            `duplicate key value violates unique constraint "ModelFileHash_pkey" (${key})`
          );
        }
        continue;
      }
      storedKeys.add(key);
      count++;
    }
    return { count };
  });
});

describe('/api/admin/temp/backfill-sha256-12', () => {
  describe('derivation', () => {
    it('writes sha256[0:12] for every stored SHA256 row', async () => {
      installCorpus([
        { fileId: FILE_A, hash: HASH_A },
        { fileId: FILE_B, hash: HASH_B },
      ]);

      const body = await runHandler({ dryRun: 'false' });

      // Literal expectations, not `normalizeScanHashes(input)` — restating the implementation
      // would pass for any consistent-but-wrong truncation.
      expect(rowsWritten()).toEqual(
        [`${FILE_A}:SHA256_12=${PREFIX_A}`, `${FILE_B}:SHA256_12=${PREFIX_B}`].sort()
      );
      expect(body.result.written).toBe(2);
      expect(body.result.derivable).toBe(2);
      expect(body.result.scanned).toBe(2);
    });

    it('derives a value present nowhere in the input, at the A1111 width', async () => {
      installCorpus([{ fileId: FILE_A, hash: HASH_A }]);
      await runHandler({ dryRun: 'false' });

      const [row] = insertAttempts;
      expect(row.hash).toBe(PREFIX_A);
      expect(row.hash).toHaveLength(12);
      // The whole point of the type: it is not the AutoV2 width (10) and not the stored SHA256.
      expect(row.hash).not.toBe(HASH_A.slice(0, 10));
      expect(row.hash).not.toBe(HASH_A);
    });

    it('never writes a row of any type other than SHA256_12', async () => {
      // A mutant that copied the source row through would re-write SHA256 and corrupt nothing
      // visibly — but it would double the table. Assert the type, not just the hash.
      installCorpus([{ fileId: FILE_A, hash: HASH_A }]);
      await runHandler({ dryRun: 'false' });

      expect(insertAttempts.map((r) => r.type)).toEqual(['SHA256_12']);
    });
  });

  describe('the all-zero sentinel', () => {
    it('skips it — deriving would make every unreachable file match every other', async () => {
      installCorpus([
        { fileId: FILE_A, hash: SENTINEL },
        { fileId: FILE_B, hash: HASH_B },
      ]);

      const body = await runHandler({ dryRun: 'false' });

      // Assert the STATE of the written set, not the absence of a substring: a `not.toContain`
      // on the zero-prefix passes for a run that wrote nothing at all, which is a different bug.
      expect(rowsWritten()).toEqual([`${FILE_B}:SHA256_12=${PREFIX_B}`]);
      expect(body.result.skippedSentinel).toBe(1);
      expect(body.result.derivable).toBe(1);
      expect(body.result.scanned).toBe(2);
    });

    it('reports it as skipped rather than written, even when it is the only row', async () => {
      installCorpus([{ fileId: FILE_A, hash: SENTINEL }]);

      const body = await runHandler({ dryRun: 'false' });

      expect(insertAttempts).toHaveLength(0);
      expect(body.result.written).toBe(0);
      expect(body.result.skippedSentinel).toBe(1);
      // ...and the walk still completed, rather than treating "nothing derivable" as an error.
      expect(body.complete).toBe(true);
    });
  });

  describe('idempotency', () => {
    it('writes nothing on a second run over the same range', async () => {
      installCorpus([
        { fileId: FILE_A, hash: HASH_A },
        { fileId: FILE_B, hash: HASH_B },
      ]);

      const first = await runHandler({ dryRun: 'false' });
      expect(first.result.written).toBe(2);

      insertAttempts = [];
      const second = await runHandler({ dryRun: 'false' });

      // The rows are still OFFERED — the endpoint does not pre-filter — but the database inserts
      // none of them. `written` must reflect what the database did, not what was offered.
      expect(second.result.written).toBe(0);
      expect(second.result.derivable).toBe(2);
      expect(storedKeys.size).toBe(2);
    });

    it('passes skipDuplicates, so a covered range cannot raise a duplicate-key error', async () => {
      // The mechanism, pinned directly. The fake throws without it, so dropping `skipDuplicates`
      // turns the test above red too — but this names the specific cause so the failure is
      // legible rather than an opaque rethrow.
      installCorpus([{ fileId: FILE_A, hash: HASH_A }], [FILE_A]);

      const body = await runHandler({ dryRun: 'false' });

      const call = dbMock.dbWrite.modelFileHash.createMany.mock.calls.at(-1)?.[0] as any;
      expect(call.skipDuplicates).toBe(true);
      expect(body.result.written).toBe(0);
    });

    it('dry run counts only rows that are genuinely missing a sibling', async () => {
      installCorpus(
        [
          { fileId: FILE_A, hash: HASH_A },
          { fileId: FILE_B, hash: HASH_B },
          { fileId: FILE_C, hash: HASH_C },
        ],
        [FILE_B] // already backfilled
      );

      const body = await runHandler({ dryRun: 'true' });

      // Reporting `derivable` (3) as the write volume would overstate the job by 50% here — the
      // exact error that makes an operator plan for a corpus-wide run that is already done.
      expect(body.result.candidates).toBe(2);
      expect(body.result.derivable).toBe(3);
      expect(body.result.written).toBe(0);
      expect(insertAttempts).toHaveLength(0);
      expect(body.dryRun).toBe(true);
    });
  });

  describe('bounds and cursor resumption', () => {
    it('stops at maxBatches and reports a cursor that resumes the walk', async () => {
      // 6 files, batchSize 2, maxBatches 2 => the run must stop after 4, not finish all 6.
      const corpus = [
        { fileId: 10, hash: HASH_A },
        { fileId: 20, hash: HASH_B },
        { fileId: 30, hash: HASH_C },
        { fileId: 40, hash: HASH_A },
        { fileId: 50, hash: HASH_B },
        { fileId: 60, hash: HASH_C },
      ];
      installCorpus(corpus);

      const first = await runHandler({ dryRun: 'false', batchSize: '2', maxBatches: '2' });

      expect(first.result.batches).toBe(2);
      expect(first.result.scanned).toBe(4);
      expect(first.complete).toBe(false);
      expect(first.lastCursor).toBe(41); // last id seen (40) + 1
      expect(rowsWritten()).toEqual(
        [
          `10:SHA256_12=${PREFIX_A}`,
          `20:SHA256_12=${PREFIX_B}`,
          `30:SHA256_12=${PREFIX_C}`,
          `40:SHA256_12=${PREFIX_A}`,
        ].sort()
      );

      // Resume exactly where it stopped: the remaining two files, and nothing re-read.
      insertAttempts = [];
      const second = await runHandler({
        dryRun: 'false',
        batchSize: '2',
        maxBatches: '2',
        start: String(first.lastCursor),
      });

      expect(second.result.scanned).toBe(2);
      expect(second.complete).toBe(true);
      expect(rowsWritten()).toEqual(
        [`50:SHA256_12=${PREFIX_B}`, `60:SHA256_12=${PREFIX_C}`].sort()
      );
      // Every file covered exactly once across the two runs.
      expect(storedKeys.size).toBe(6);
    });

    it('honours batchSize as the page bound', async () => {
      const corpus = Array.from({ length: 9 }, (_, i) => ({
        fileId: (i + 1) * 10,
        hash: [HASH_A, HASH_B, HASH_C][i % 3],
      }));
      installCorpus(corpus);

      await runHandler({ dryRun: 'false', batchSize: '3', maxBatches: '1' });

      // One batch of exactly 3 — not the whole corpus, and not a hardcoded default page size.
      const pageCalls = dbMock.dbRead.modelFileHash.findMany.mock.calls.filter(
        (c: any) => c[0].where.type === 'SHA256'
      );
      expect(pageCalls).toHaveLength(1);
      expect(pageCalls[0][0].take).toBe(3);
      expect(insertAttempts).toHaveLength(3);
    });

    it('starts at `start`, leaving earlier files untouched', async () => {
      installCorpus([
        { fileId: FILE_A, hash: HASH_A },
        { fileId: FILE_B, hash: HASH_B },
        { fileId: FILE_C, hash: HASH_C },
      ]);

      await runHandler({ dryRun: 'false', start: String(FILE_B) });

      // FILE_A is before the cursor and must not be written — a `start` that is read but not
      // applied to the query would silently re-walk the whole corpus on every resume.
      expect(rowsWritten()).toEqual(
        [`${FILE_B}:SHA256_12=${PREFIX_B}`, `${FILE_C}:SHA256_12=${PREFIX_C}`].sort()
      );
    });

    it('respects `end` as the upper bound of the range', async () => {
      installCorpus([
        { fileId: FILE_A, hash: HASH_A },
        { fileId: FILE_B, hash: HASH_B },
        { fileId: FILE_C, hash: HASH_C },
      ]);

      const body = await runHandler({ dryRun: 'false', end: String(FILE_B) });

      expect(rowsWritten()).toEqual(
        [`${FILE_A}:SHA256_12=${PREFIX_A}`, `${FILE_B}:SHA256_12=${PREFIX_B}`].sort()
      );
      expect(body.complete).toBe(true);
    });

    it('routes a mid-run failure through the shared 500 chokepoint, not a hand-rolled body', async () => {
      // A hand-rolled `{ error: (e as Error).message }` here would leak driver text — for a Prisma
      // error the table + column, for a pg 23505 the offending ROW VALUE (civitai#3845). The
      // repo-wide ledger in rest-error-envelope-ledger.test.ts blocks that class; this pins the
      // behaviour at the one site, so the endpoint cannot regress back to it silently.
      installCorpus([{ fileId: FILE_A, hash: HASH_A }]);
      const boom = new Error('relation "ModelFileHash" column "hash" does not exist');
      dbMock.dbWrite.modelFileHash.createMany.mockRejectedValueOnce(boom);

      const req = { method: 'GET', query: { dryRun: 'false' } } as unknown as NextApiRequest;
      const json = vi.fn().mockReturnThis();
      const status = vi.fn().mockReturnThis();
      await handler(req, { status, json } as unknown as NextApiResponse);

      expect(helperMocks.handleEndpointError).toHaveBeenCalledWith(expect.anything(), boom);
      // And nothing carrying the driver text was written to the response directly.
      const bodies = JSON.stringify(json.mock.calls);
      expect(bodies).not.toContain('does not exist');
    });

    it('rejects an out-of-range batchSize rather than running unbounded', async () => {
      installCorpus([{ fileId: FILE_A, hash: HASH_A }]);

      const req = { method: 'GET', query: { batchSize: '999999' } } as unknown as NextApiRequest;
      const json = vi.fn().mockReturnThis();
      const status = vi.fn().mockReturnThis();
      await handler(req, { status, json } as unknown as NextApiResponse);

      expect(status).toHaveBeenCalledWith(400);
      expect(insertAttempts).toHaveLength(0);
    });
  });
});
