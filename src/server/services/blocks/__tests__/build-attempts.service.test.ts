import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * `build-attempts.service` — every function is best-effort, because the table's migration
 * is applied by hand and the code ships first. These pin the answer each one gives when
 * the table is missing, plus the stale-run decision on real row sequences.
 */

// The canonical shared DB mock (registered for every file by the test setup), not a
// per-file mock of the client module.
const db = {
  create: dbMock.dbWrite.appBlockBuildAttempt.create,
  findFirst: dbMock.dbWrite.appBlockBuildAttempt.findFirst,
  findMany: dbMock.dbRead.appBlockBuildAttempt.findMany,
  requestFindFirst: dbMock.dbWrite.appBlockPublishRequest.findFirst,
};

import {
  isSupersededRun,
  latestBuildAttemptSignals,
  recordBuildAttempt,
  recordBuildTriggered,
} from '~/server/services/blocks/build-attempts.service';

const SHA = 'a'.repeat(40);
const missingTable = () =>
  Object.assign(new Error('The table `public.app_block_build_attempts` does not exist'), {
    code: 'P2021',
  });

beforeEach(() => {
  vi.clearAllMocks();
  // Reset implementations too: a case below that makes the table "missing" must not leak.
  for (const fn of Object.values(db)) fn.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  db.create.mockResolvedValue({ id: 1 });
  db.requestFindFirst.mockResolvedValue({ id: 'pubreq_A' });
});

describe('recordBuildAttempt', () => {
  it('resolves the approved request for a build-mode row and appends one row', async () => {
    expect(
      await recordBuildAttempt({
        mode: 'build',
        status: 'failed',
        slug: 's',
        sha: SHA,
        runId: 'r-1',
      })
    ).toBe(true);
    expect(db.requestFindFirst).toHaveBeenCalledWith({
      where: { slug: 's', forgejoCommitSha: SHA, status: 'approved' },
      select: { id: true },
    });
    expect(db.create).toHaveBeenCalledWith({
      data: {
        publishRequestId: 'pubreq_A',
        slug: 's',
        sha: SHA,
        runId: 'r-1',
        mode: 'build',
        status: 'failed',
        failedStep: null,
        failedReason: null,
        failureClass: null,
        createdAt: expect.any(Date),
      },
      select: { id: true },
    });
  });

  it('an outcome row is app-stamped; a trigger row is not', async () => {
    await recordBuildTriggered({
      mode: 'build',
      publishRequestId: 'p',
      slug: 's',
      sha: SHA,
      runName: 'r-2',
    });
    expect(db.create.mock.calls.at(-1)?.[0].data).not.toHaveProperty('createdAt');
  });

  it('uses a given publish request id and does not look one up', async () => {
    await recordBuildAttempt({
      mode: 'review',
      status: 'succeeded',
      slug: 's',
      sha: SHA,
      publishRequestId: 'pubreq_R',
    });
    expect(db.requestFindFirst).not.toHaveBeenCalled();
    expect(db.create.mock.calls[0][0].data.publishRequestId).toBe('pubreq_R');
  });

  it('TABLE MISSING → false, never throws', async () => {
    db.create.mockRejectedValue(missingTable());
    await expect(
      recordBuildAttempt({ mode: 'build', status: 'failed', slug: 's', sha: SHA })
    ).resolves.toBe(false);
  });
});

describe('recordBuildTriggered', () => {
  it('records a valid run name as a triggered row', async () => {
    expect(
      await recordBuildTriggered({
        mode: 'build',
        publishRequestId: 'pubreq_A',
        slug: 's',
        sha: SHA,
        runName: 'app-blocks-s-aaaaaaaa-111111',
      })
    ).toBe(true);
    expect(db.create.mock.calls[0][0].data).toMatchObject({
      status: 'triggered',
      runId: 'app-blocks-s-aaaaaaaa-111111',
      publishRequestId: 'pubreq_A',
    });
  });

  it('records a 75-char review run name — the guard must not go silently inactive for long slugs', async () => {
    const runName = `app-blocks-review-${'a'.repeat(41)}-0123abcd-9f8e7d`;
    expect(
      await recordBuildTriggered({
        mode: 'review',
        publishRequestId: 'p',
        slug: 's',
        sha: SHA,
        runName,
      })
    ).toBe(true);
    expect(db.create.mock.calls.at(-1)?.[0].data.runId).toBe(runName);
  });

  it.each(['', undefined, 'Not_A_Run'])(
    'does not record an invalid run name (%j)',
    async (runName) => {
      expect(
        await recordBuildTriggered({
          mode: 'build',
          publishRequestId: 'p',
          slug: 's',
          sha: SHA,
          runName,
        })
      ).toBe(false);
      expect(db.create).not.toHaveBeenCalled();
    }
  );
});

describe('isSupersededRun', () => {
  const args = { mode: 'build' as const, slug: 's', sha: SHA };

  it('no runId → false without a query', async () => {
    expect(await isSupersededRun({ ...args, runId: undefined })).toBe(false);
    expect(db.findFirst).not.toHaveBeenCalled();
  });

  it('TABLE MISSING → false (the guard is simply inactive)', async () => {
    db.findFirst.mockRejectedValue(missingTable());
    expect(await isSupersededRun({ ...args, runId: 'old' })).toBe(false);
  });

  it('no trigger recorded at all → false', async () => {
    db.findFirst.mockResolvedValue(null);
    expect(await isSupersededRun({ ...args, runId: 'old' })).toBe(false);
  });

  it('the callback’s run IS the latest trigger → false', async () => {
    // The second lookup would find this run's own row — so only the equality check
    // can answer false here.
    db.findFirst.mockResolvedValueOnce({ runId: 'old' }).mockResolvedValueOnce({ id: 1 });
    expect(await isSupersededRun({ ...args, runId: 'old' })).toBe(false);
  });

  it('a newer trigger exists but this run was never recorded → false (do not drop a current run)', async () => {
    db.findFirst.mockResolvedValueOnce({ runId: 'new' }).mockResolvedValueOnce(null);
    expect(await isSupersededRun({ ...args, runId: 'unrecorded' })).toBe(false);
  });

  it('this run was recorded AND a newer trigger names another run → true', async () => {
    db.findFirst.mockResolvedValueOnce({ runId: 'new' }).mockResolvedValueOnce({ id: 1 });
    expect(await isSupersededRun({ ...args, runId: 'old' })).toBe(true);
    // Both lookups are scoped to trigger rows of THIS mode + version, newest first.
    expect(db.findFirst.mock.calls[0][0]).toEqual({
      where: { mode: 'build', slug: 's', sha: SHA, status: 'triggered' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { runId: true },
    });
    expect(db.findFirst.mock.calls[1][0].where).toEqual({
      mode: 'build',
      slug: 's',
      sha: SHA,
      status: 'triggered',
      runId: 'old',
    });
  });
});

describe('latestBuildAttemptSignals', () => {
  const T = new Date('2026-10-08T19:00:00Z');
  const after = new Date(T.getTime() + 5);
  const before = new Date(T.getTime() - 5);

  it('no requests → empty map, no query', async () => {
    expect((await latestBuildAttemptSignals([])).size).toBe(0);
    expect(db.findMany).not.toHaveBeenCalled();
  });

  it('maps each request to its latest OUTCOME row, newest first, outcomes only', async () => {
    db.findMany.mockResolvedValue([
      { publishRequestId: 'p1', failedStep: 'scan', failureClass: 'unknown', createdAt: after },
      { publishRequestId: 'p2', failedStep: null, failureClass: null, createdAt: after },
    ]);
    const map = await latestBuildAttemptSignals([
      { id: 'p1', deployUpdatedAt: T },
      { id: 'p2', deployUpdatedAt: T },
      { id: 'p3', deployUpdatedAt: T },
    ]);
    expect(Object.fromEntries(map)).toEqual({
      p1: { failedStep: 'scan', failureClass: 'unknown' },
      p2: { failedStep: null, failureClass: null },
    });
    expect(db.findMany.mock.calls[0][0]).toEqual({
      where: {
        publishRequestId: { in: ['p1', 'p2', 'p3'] },
        mode: 'build',
        // Outcomes only: trigger rows are not outcomes.
        status: { in: ['succeeded', 'failed'] },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      distinct: ['publishRequestId'],
      select: { publishRequestId: true, failedStep: true, failureClass: true, createdAt: true },
    });
  });

  it('drops a row OLDER than the request’s last deploy_state transition (it describes something else)', async () => {
    db.findMany.mockResolvedValue([
      {
        publishRequestId: 'p_stale',
        failedStep: 'scan',
        failureClass: 'unknown',
        createdAt: before,
      },
      { publishRequestId: 'p_equal', failedStep: 'clone', failureClass: 'platform', createdAt: T },
      {
        publishRequestId: 'p_noclock',
        failedStep: 'push',
        failureClass: 'transient',
        createdAt: before,
      },
    ]);
    const map = await latestBuildAttemptSignals([
      { id: 'p_stale', deployUpdatedAt: T },
      { id: 'p_equal', deployUpdatedAt: T },
      { id: 'p_noclock', deployUpdatedAt: null },
    ]);
    expect(Object.fromEntries(map)).toEqual({
      p_equal: { failedStep: 'clone', failureClass: 'platform' },
      p_noclock: { failedStep: 'push', failureClass: 'transient' },
    });
  });

  it('TABLE MISSING → empty map, never throws', async () => {
    db.findMany.mockRejectedValue(missingTable());
    expect((await latestBuildAttemptSignals([{ id: 'p1', deployUpdatedAt: T }])).size).toBe(0);
  });
});
