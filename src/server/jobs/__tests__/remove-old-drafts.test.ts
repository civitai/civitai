import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDeregisterBatch, calls } = vi.hoisted(() => ({
  mockDeregisterBatch: vi.fn(() => Promise.resolve({ deleted: 0 })),
  // Tracked so we can assert the per-batch error path fired (the job's internal
  // errorCount has no external surface other than this Axiom error log).
  // Ordered log of the side effects we care about, so we can assert the
  // versionId collection happens BEFORE the delete and deregister happens AFTER.
  calls: [] as string[],
}));

vi.mock('~/utils/storage-resolver', () => ({ deregisterFileLocationsBatch: mockDeregisterBatch }));
vi.mock('~/utils/logging', () => ({ createLogger: () => () => undefined }));
vi.mock('~/server/jobs/job', () => ({ createJob: (_n: string, _c: string, fn: unknown) => fn }));

import { removeOldDrafts, ACTIVITY_WINDOW_DAYS } from '~/server/jobs/remove-old-drafts';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;
const mockLogToAxiom = loggingMock.logToAxiom;

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS);

// Fixture ages sit far off the 30-day boundary on BOTH sides — 200 days for
// "long quiet", 5 days for "still in use". Nothing is built at 30, so no clause
// can be reached (or missed) by landing exactly on its own cutoff, and a mutant
// that widens the window to 300 days has somewhere to be caught.
const QUIET_DAYS = 200;
const RECENT_DAYS = 5;
const quiet = () => daysAgo(QUIET_DAYS);
const recent = () => daysAgo(RECENT_DAYS);

/**
 * A row shaped like the job's per-batch ModelVersion lookup actually returns.
 * Defaults to "long quiet in every column" so each test names only the one
 * timestamp it is exercising.
 */
function versionRow(over: { id: number; modelId: number } & Record<string, unknown>) {
  return { createdAt: quiet(), updatedAt: quiet(), latestFileAt: null, ...over };
}

/** The tagged-template args the replica SELECT is handed: [strings, ...binds]. */
function readSql() {
  const [strings] = mockDbRead.$queryRaw.mock.calls[0] as [string[], ...unknown[]];
  return strings.join('?');
}

/**
 * The whole WHERE predicate of the replica SELECT, comments stripped and
 * whitespace collapsed.
 */
function readPredicate() {
  const flat = readSql()
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.slice(flat.indexOf('WHERE '), flat.indexOf(' ORDER BY'));
}

/** Model ids handed to a given `DELETE FROM "Model"` call. */
function deleteBatches() {
  return mockDbWrite.$executeRaw.mock.calls.map((c) => c[1] as number[]);
}

function axiomEvents(message: string) {
  return mockLogToAxiom.mock.calls
    .map(([arg]) => arg as Record<string, unknown>)
    .filter((arg) => arg.name === 'remove-old-drafts' && arg.message === message);
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
});

describe('removeOldDrafts', () => {
  describe('the replica SELECT predicate', () => {
    // 🔴 This is a SPELLED guard, not a behavioural one. It pins the exact text
    // of the predicate, so an equivalent reword — swapping the two NOT EXISTS
    // clauses, aliasing the tables differently, writing `now() - '30 days'::interval`
    // — fails it while changing nothing about which models get destroyed. It
    // proves only that the predicate has not silently changed since someone last
    // reasoned about it; it proves NOTHING about what the SQL does. The
    // behavioural coverage of the same rule lives in the primary-side fence
    // tests below and in remove-old-drafts-activity-filter.test.ts, because this
    // repo has no DB-backed vitest project and the SQL itself cannot be run here.
    it('pins the whole predicate, including both activity fences', async () => {
      mockDbRead.$queryRaw.mockResolvedValue([]);

      await (removeOldDrafts as unknown as () => Promise<void>)();

      expect(readPredicate()).toBe(
        `WHERE m.status IN ('Draft', 'Deleted') ` +
          `AND m."updatedAt" < now() - INTERVAL '30 days' ` +
          `AND mm."downloadCount" < 10 ` +
          `AND m."availability" != 'Private'::"Availability" ` +
          `AND NOT EXISTS (SELECT 1 FROM "ModelVersion" mv ` +
          `WHERE mv."modelId" = m.id ` +
          `AND (mv."createdAt" > now() - INTERVAL '30 days' ` +
          `OR mv."updatedAt" > now() - INTERVAL '30 days')) ` +
          `AND NOT EXISTS (SELECT 1 FROM "ModelVersion" mv2 ` +
          `JOIN "ModelFile" mf ON mf."modelVersionId" = mv2.id ` +
          `WHERE mv2."modelId" = m.id ` +
          `AND mf."createdAt" > now() - INTERVAL '30 days')`
      );
    });

    // Seam guard: the SQL literal and the constant the TypeScript fence uses are
    // two independent spellings of one rule. Nothing else makes them agree.
    it('spells every interval with the same window the runtime fence uses', async () => {
      mockDbRead.$queryRaw.mockResolvedValue([]);

      await (removeOldDrafts as unknown as () => Promise<void>)();

      const sql = readSql();
      const intervals = sql.match(/INTERVAL '\d+ days'/g) ?? [];
      expect(intervals).toEqual(Array(4).fill(`INTERVAL '${ACTIVITY_WINDOW_DAYS} days'`));
    });

    // The selected columns are what makes a loss report answerable — see the
    // "logs the ids" tests below, which are void if userId stops being selected.
    it('selects the owning userId alongside the model id', async () => {
      mockDbRead.$queryRaw.mockResolvedValue([]);

      await (removeOldDrafts as unknown as () => Promise<void>)();

      expect(readSql().replace(/\s+/g, ' ')).toContain('SELECT DISTINCT m.id, m."userId"');
    });
  });

  describe('the primary-side activity fence', () => {
    // POSITIVE CONTROL for every "spares" test below. Without it "0 models
    // deleted" would satisfy all of them, and a harness wired to nothing — or a
    // fence that refuses everything — would read green across the board.
    it('deletes a candidate whose versions and files have all been quiet', async () => {
      mockDbRead.$queryRaw.mockResolvedValue([{ id: 42, userId: 7 }]);
      mockDbWrite.$queryRaw.mockResolvedValue([versionRow({ id: 100, modelId: 42 })]);
      mockDbWrite.$executeRaw.mockResolvedValue(1);

      await (removeOldDrafts as unknown as () => Promise<void>)();

      expect(
        deleteBatches(),
        'baseline fixtures must produce a NON-EMPTY delete list, or every "spares" assertion passes vacuously'
      ).toEqual([[42]]);
      expect(mockDeregisterBatch).toHaveBeenCalledWith([100]);
    });

    it('spares a model whose version was CREATED inside the window', async () => {
      mockDbRead.$queryRaw.mockResolvedValue([{ id: 42, userId: 7 }]);
      mockDbWrite.$queryRaw.mockResolvedValue([
        versionRow({ id: 100, modelId: 42, createdAt: recent() }),
      ]);

      await (removeOldDrafts as unknown as () => Promise<void>)();

      expect(deleteBatches(), 'a version created inside the window must spare its model').toEqual(
        []
      );
      expect(mockDeregisterBatch).not.toHaveBeenCalled();
    });

    it('spares a model whose version was UPDATED inside the window', async () => {
      mockDbRead.$queryRaw.mockResolvedValue([{ id: 42, userId: 7 }]);
      mockDbWrite.$queryRaw.mockResolvedValue([
        versionRow({ id: 100, modelId: 42, updatedAt: recent() }),
      ]);

      await (removeOldDrafts as unknown as () => Promise<void>)();

      expect(deleteBatches(), 'a version updated inside the window must spare its model').toEqual(
        []
      );
      expect(mockDeregisterBatch).not.toHaveBeenCalled();
    });

    // The reported exhibit, in fixture form: the model row and its only version
    // were both created long ago and never touched again, and the finished
    // resource landed as a ModelFile days ago. Neither Model."updatedAt" nor
    // ModelVersion."createdAt" can see it — only the file timestamp can.
    it('spares a model whose FILE was created inside the window, with an otherwise ancient version', async () => {
      mockDbRead.$queryRaw.mockResolvedValue([{ id: 2831418, userId: 7 }]);
      mockDbWrite.$queryRaw.mockResolvedValue([
        versionRow({ id: 3194997, modelId: 2831418, latestFileAt: recent() }),
      ]);

      await (removeOldDrafts as unknown as () => Promise<void>)();

      expect(
        deleteBatches(),
        'a file created inside the window must spare its model even when the version is ancient'
      ).toEqual([]);
      expect(mockDeregisterBatch).not.toHaveBeenCalled();
    });

    it('deletes only the quiet models of a mixed batch and deregisters only their versions', async () => {
      mockDbRead.$queryRaw.mockResolvedValue([
        { id: 1, userId: 11 },
        { id: 2, userId: 22 },
      ]);
      mockDbWrite.$queryRaw.mockResolvedValue([
        versionRow({ id: 100, modelId: 1, latestFileAt: recent() }), // still in use
        versionRow({ id: 200, modelId: 2 }), // long quiet
      ]);
      mockDbWrite.$executeRaw.mockResolvedValue(1);

      await (removeOldDrafts as unknown as () => Promise<void>)();

      expect(deleteBatches()).toEqual([[2]]);
      // Deregistering the spared model's file_locations would drop its objects
      // out of the quarantine allowlist — the same loss by another route.
      expect(mockDeregisterBatch).toHaveBeenCalledTimes(1);
      expect(mockDeregisterBatch).toHaveBeenCalledWith([200]);
    });

    it('spares the whole batch when a row cannot be attributed to a model', async () => {
      mockDbRead.$queryRaw.mockResolvedValue([
        { id: 1, userId: 11 },
        { id: 2, userId: 22 },
      ]);
      // Query shape drifted: no modelId to hang the activity on.
      mockDbWrite.$queryRaw.mockResolvedValue([
        { id: 100, createdAt: quiet(), updatedAt: quiet() },
      ]);

      await (removeOldDrafts as unknown as () => Promise<void>)();

      expect(
        deleteBatches(),
        'unattributable activity must fail CLOSED across the batch, not protect nothing'
      ).toEqual([]);
    });

    it('reports the spared models to Axiom so the two fences disagreeing is visible', async () => {
      mockDbRead.$queryRaw.mockResolvedValue([{ id: 42, userId: 7 }]);
      mockDbWrite.$queryRaw.mockResolvedValue([
        versionRow({ id: 100, modelId: 42, latestFileAt: recent() }),
      ]);

      await (removeOldDrafts as unknown as () => Promise<void>)();

      expect(axiomEvents('Skipped old draft models with recent version or file activity')).toEqual([
        expect.objectContaining({ type: 'warning', modelIds: [42], userIds: [7] }),
      ]);
    });
  });

  describe('identifying what was destroyed', () => {
    it('logs the deleted model ids and their owners', async () => {
      mockDbRead.$queryRaw.mockResolvedValue([
        { id: 1, userId: 11 },
        { id: 2, userId: 22 },
      ]);
      mockDbWrite.$queryRaw.mockResolvedValue([
        versionRow({ id: 100, modelId: 1 }),
        versionRow({ id: 200, modelId: 2 }),
      ]);
      mockDbWrite.$executeRaw.mockResolvedValue(1);

      await (removeOldDrafts as unknown as () => Promise<void>)();

      expect(axiomEvents('Removed old draft models')).toEqual([
        expect.objectContaining({ type: 'info', modelIds: [1, 2], userIds: [11, 22] }),
      ]);
    });

    it('keeps each id log bounded to one batch', async () => {
      // 11 models → two batches (BATCH_SIZE=10), so two events of ≤10 ids each
      // rather than one field carrying every id of a 1,000-model run.
      const models = Array.from({ length: 11 }, (_, i) => ({ id: i + 1, userId: 900 + i }));
      mockDbRead.$queryRaw.mockResolvedValue(models);
      mockDbWrite.$queryRaw.mockImplementation(async (_s: unknown, batch: number[]) =>
        batch.map((modelId) => versionRow({ id: modelId * 10, modelId }))
      );
      mockDbWrite.$executeRaw.mockResolvedValue(1);

      await (removeOldDrafts as unknown as () => Promise<void>)();

      const logged = axiomEvents('Removed old draft models').map((e) => e.modelIds as number[]);
      expect(logged).toEqual([Array.from({ length: 10 }, (_, i) => i + 1), [11]]);
      expect(Math.max(...logged.map((ids) => ids.length))).toBeLessThanOrEqual(10);
    });

    it('names the batch on the failure log so a failed delete is attributable too', async () => {
      mockDbRead.$queryRaw.mockResolvedValue([{ id: 42, userId: 7 }]);
      mockDbWrite.$queryRaw.mockResolvedValue([versionRow({ id: 100, modelId: 42 })]);
      mockDbWrite.$executeRaw.mockRejectedValue(new Error('deadlock detected'));

      await (removeOldDrafts as unknown as () => Promise<void>)();

      expect(axiomEvents('Failed to remove batch of old draft models')).toEqual([
        expect.objectContaining({ type: 'error', modelIds: [42] }),
      ]);
    });
  });

  describe('batching and the storage-resolver deregister', () => {
    it('collects version ids pre-delete then deregisters them post-delete', async () => {
      // Replica lookup: one old draft model (id 42).
      mockDbRead.$queryRaw.mockResolvedValue([{ id: 42, userId: 7 }]);
      // dbWrite.$queryRaw = the pre-delete version-id lookup.
      mockDbWrite.$queryRaw.mockImplementation(async () => {
        calls.push('collect-versions');
        return [versionRow({ id: 100, modelId: 42 }), versionRow({ id: 101, modelId: 42 })];
      });
      // dbWrite.$executeRaw = the cascade delete.
      mockDbWrite.$executeRaw.mockImplementation(async () => {
        calls.push('delete');
        return 1;
      });
      mockDeregisterBatch.mockImplementation(async () => {
        calls.push('deregister');
        return { deleted: 2 };
      });

      await (removeOldDrafts as unknown as () => Promise<void>)();

      // versionIds gathered before the delete, deregister runs after it.
      expect(calls).toEqual(['collect-versions', 'delete', 'deregister']);
      expect(mockDeregisterBatch).toHaveBeenCalledWith([100, 101]);
    });

    it('does not call deregister when a batch has no versions', async () => {
      mockDbRead.$queryRaw.mockResolvedValue([{ id: 42, userId: 7 }]);
      mockDbWrite.$queryRaw.mockResolvedValue([]); // no versions on the model
      mockDbWrite.$executeRaw.mockResolvedValue(1);

      await (removeOldDrafts as unknown as () => Promise<void>)();

      expect(mockDbWrite.$executeRaw).toHaveBeenCalledTimes(1);
      expect(mockDeregisterBatch).not.toHaveBeenCalled();
    });

    it('does nothing when there are no old drafts to remove', async () => {
      mockDbRead.$queryRaw.mockResolvedValue([]);

      await (removeOldDrafts as unknown as () => Promise<void>)();

      expect(mockDbWrite.$executeRaw).not.toHaveBeenCalled();
      expect(mockDeregisterBatch).not.toHaveBeenCalled();
    });

    it('does not deregister a batch whose delete fails, counts the error, and continues', async () => {
      // 11 models → two batches (BATCH_SIZE=10): [1..10] then [11].
      const models = Array.from({ length: 11 }, (_, i) => ({ id: i + 1, userId: 900 + i }));
      mockDbRead.$queryRaw.mockResolvedValue(models);

      // Per-batch version lookup — return ids keyed off which batch is asked for.
      mockDbWrite.$queryRaw.mockImplementation(async (_strings: unknown, batch: number[]) =>
        batch.includes(1)
          ? [versionRow({ id: 100, modelId: 1 }), versionRow({ id: 101, modelId: 2 })]
          : [versionRow({ id: 200, modelId: 11 })]
      );
      // The DELETE FROM "Model" rejects for the FIRST batch only; the second succeeds.
      mockDbWrite.$executeRaw.mockImplementation(async (_strings: unknown, batch: number[]) => {
        if (batch.includes(1)) throw new Error('deadlock detected');
        return 1;
      });

      // Job must not throw out — a failed batch is caught and the loop continues.
      await expect((removeOldDrafts as unknown as () => Promise<void>)()).resolves.toBeUndefined();

      // The failed batch's versions ([100, 101]) are NEVER deregistered — the delete
      // never committed, so there are no orphaned file_locations to reap.
      expect(mockDeregisterBatch).toHaveBeenCalledTimes(1);
      expect(mockDeregisterBatch).toHaveBeenCalledWith([200]);
      expect(mockDeregisterBatch).not.toHaveBeenCalledWith([100, 101]);

      // errorCount increments → surfaced as the batch-failure Axiom error log.
      expect(mockLogToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          name: 'remove-old-drafts',
          message: 'Failed to remove batch of old draft models',
        })
      );
    });

    it('scopes each batch to its own version ids with no cross-batch bleed', async () => {
      // 11 models → two batches (BATCH_SIZE=10): [1..10] then [11].
      const models = Array.from({ length: 11 }, (_, i) => ({ id: i + 1, userId: 900 + i }));
      mockDbRead.$queryRaw.mockResolvedValue(models);

      // Each batch's ModelVersion SELECT returns a disjoint set of version ids.
      mockDbWrite.$queryRaw.mockImplementation(async (_strings: unknown, batch: number[]) =>
        batch.includes(1)
          ? [versionRow({ id: 1000, modelId: 1 }), versionRow({ id: 1001, modelId: 2 })]
          : [versionRow({ id: 2000, modelId: 11 })]
      );
      mockDbWrite.$executeRaw.mockResolvedValue(1);

      await (removeOldDrafts as unknown as () => Promise<void>)();

      // The version SELECT is scoped to exactly one batch of model ids per call.
      const selectBatches = mockDbWrite.$queryRaw.mock.calls.map((c) => c[1] as number[]);
      expect(selectBatches).toEqual([Array.from({ length: 10 }, (_, i) => i + 1), [11]]);

      // Deregister runs once per batch, each with only that batch's version ids —
      // no cross-batch bleed (batch 1's [1000,1001] and batch 2's [2000] never mix).
      expect(mockDeregisterBatch).toHaveBeenCalledTimes(2);
      expect(mockDeregisterBatch).toHaveBeenNthCalledWith(1, [1000, 1001]);
      expect(mockDeregisterBatch).toHaveBeenNthCalledWith(2, [2000]);
    });
  });
});
