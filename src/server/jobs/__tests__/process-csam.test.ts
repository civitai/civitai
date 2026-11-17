import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Batch integrity for the hourly CSAM jobs.
 *
 * The defect: both loops caught per report so that one bad report could not stop the rest, then
 * read `e.message` inside the catch block. A rejection whose value is not an object — which is
 * exactly what `uploadStream`'s bare `reject()` produced — makes that read throw a `TypeError`
 * *inside the catch*, where nothing catches it. It escapes the `for` loop and abandons every
 * remaining report in that batch, silently, having logged nothing.
 *
 * All ids and messages below are invented.
 */

const mocks = vi.hoisted(() => ({
  getCsamsToArchive: vi.fn(),
  getCsamsToReport: vi.fn(),
  archiveCsamDataForReport: vi.fn(),
  processCsamReport: vi.fn(),
  logBlockedCsamReports: vi.fn(),
  logOverdueEvidenceApprovals: vi.fn(async () => undefined),
  getCsamsToRemoveContent: vi.fn(async () => []),
  sweepStaleSendDirs: vi.fn(async (): Promise<string[]> => []),
  sweepArchiveScratchDirs: vi.fn(async (): Promise<string[]> => []),
}));

vi.mock('~/server/services/csam.service-new', () => mocks);

const evidence = vi.hoisted(() => ({ checkCsamArchiveEvidence: vi.fn() }));
vi.mock('~/server/services/csam-archive-evidence.service', () => evidence);

// The archive switch: the flag, the separate archiver's queue, and the stamp read-back.
const sw = vi.hoisted(() => ({
  flag: true as boolean | null,
  // Like the real client: nothing to evaluate until init has run, so a read before init is null.
  initialised: false,
  initFails: false,
  queued: new Set<number>(),
  stamped: new Set<number>(),
  stampReads: [] as unknown[][],
  stampFails: new Set<number>(),
  archiveQueueStates: vi.fn(),
}));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensureFliptInitialized: vi.fn(async () => {
    if (sw.initFails) throw new Error('synthetic init failure');
    sw.initialised = true;
  }),
  isFliptSync: vi.fn(() => (sw.initialised ? sw.flag : null)),
}));
vi.mock('@civitai/db-queries/evidence-archive-queue', () => ({
  archiveQueueStates: sw.archiveQueueStates,
}));
vi.mock('~/server/db/kyselyDb', () => ({
  kyselyWrite: {
    selectFrom: (table: string) => ({
      select: (column: string) => ({
        where: (where: string, op: string, id: number) => {
          sw.stampReads.push([table, column, where, op, id]);
          return {
            executeTakeFirst: async () => {
              if (sw.stampFails.has(id)) throw new Error('synthetic read failure');
              return { archivedAt: sw.stamped.has(id) ? new Date() : null };
            },
          };
        },
      }),
    }),
  },
}));

import {
  CSAM_ARCHIVE_JOB_LOCK_SECONDS,
  CSAM_ARCHIVE_MEASURED_PASS_SECONDS,
  CSAM_SEND_JOB_LOCK_SECONDS,
  csamJobs,
} from '~/server/jobs/process-csam';
import { createDisconnectHandler, createJob } from '~/server/jobs/job';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { JOB_QUEUE_OVERDUE_MINUTES } from '@civitai/shared/job-queue';
import { kyselyWrite } from '~/server/db/kyselyDb';

const archiveJob = csamJobs.find((job) => job.name === 'archive-csam-reports');
const sendJob = csamJobs.find((job) => job.name === 'send-csam-reports');

const reports = [{ id: 8801 }, { id: 8802 }, { id: 8803 }];

beforeEach(() => {
  vi.clearAllMocks();
  sw.flag = true;
  sw.initialised = false;
  sw.initFails = false;
  sw.queued = new Set();
  sw.stamped = new Set();
  sw.stampReads = [];
  sw.stampFails = new Set();
  sw.archiveQueueStates.mockImplementation(
    async (_db: unknown, ids: number[]) =>
      new Map(ids.filter((id) => sw.queued.has(id)).map((id) => [id, 'queued']))
  );
  mocks.getCsamsToArchive.mockResolvedValue(reports);
  mocks.getCsamsToReport.mockResolvedValue(reports);
  mocks.archiveCsamDataForReport.mockResolvedValue(undefined);
  mocks.processCsamReport.mockResolvedValue(undefined);
  mocks.logBlockedCsamReports.mockResolvedValue(undefined);
  evidence.checkCsamArchiveEvidence.mockResolvedValue(undefined);
});

/** The exact pre-fix failure: `Promise.reject()` with no argument. */
const rejectWithUndefined = () => Promise.reject();

describe('archive-csam-reports batch isolation', () => {
  it('POSITIVE CONTROL: a healthy batch reaches every report', async () => {
    await archiveJob!.run({}).result;
    expect(mocks.archiveCsamDataForReport).toHaveBeenCalledTimes(reports.length);
  });

  it('continues the batch when a report rejects with a non-Error value', async () => {
    mocks.archiveCsamDataForReport.mockImplementationOnce(rejectWithUndefined);

    // Pre-fix: `e.message` throws `TypeError: Cannot read properties of undefined (reading
    // 'message')` from inside the catch, the job promise rejects, and reports 8802 and 8803 are
    // never attempted.
    await expect(archiveJob!.run({}).result).resolves.not.toThrow();

    expect(mocks.archiveCsamDataForReport).toHaveBeenCalledTimes(reports.length);
    expect(mocks.archiveCsamDataForReport).toHaveBeenLastCalledWith(reports[2]);
  });

  it('still logs something identifiable for the failed report', async () => {
    mocks.archiveCsamDataForReport.mockImplementationOnce(rejectWithUndefined);

    await archiveJob!.run({}).result;

    // A message of `undefined` would make the log line useless, which is the other half of the
    // fix — extracting safely is not the same as extracting nothing.
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'csam-report', subType: 'archive-data' })
    );
    const logged = loggingMock.logToAxiom.mock.calls
      .map(([arg]) => arg as { subType?: string; message?: unknown })
      .filter((arg) => arg?.subType === 'archive-data');
    expect(logged).toHaveLength(1);
    expect(typeof logged[0].message).toBe('string');
    expect(logged[0].message).toBe('undefined');
  });

  it.each([
    ['a string', 'plain string failure', 'plain string failure'],
    ['null', null, 'null'],
    ['a plain object', { code: 'ENOENT' }, '{"code":"ENOENT"}'],
  ])('survives a rejection that is %s', async (_label, value, expected) => {
    mocks.archiveCsamDataForReport.mockImplementationOnce(() => Promise.reject(value));

    await expect(archiveJob!.run({}).result).resolves.not.toThrow();

    expect(mocks.archiveCsamDataForReport).toHaveBeenCalledTimes(reports.length);
    const logged = loggingMock.logToAxiom.mock.calls
      .map(([arg]) => arg as { subType?: string; message?: unknown })
      .filter((arg) => arg?.subType === 'archive-data');
    expect(logged[0].message).toBe(expected);
  });

  it('preserves the message of a real Error', async () => {
    mocks.archiveCsamDataForReport.mockImplementationOnce(() =>
      Promise.reject(new Error('synthetic archive failure'))
    );

    await archiveJob!.run({}).result;

    const logged = loggingMock.logToAxiom.mock.calls
      .map(([arg]) => arg as { subType?: string; message?: unknown })
      .filter((arg) => arg?.subType === 'archive-data');
    expect(logged[0].message).toBe('synthetic archive failure');
  });

  it('checks the stored evidence after the batch, even when a report failed', async () => {
    mocks.archiveCsamDataForReport.mockImplementationOnce(() =>
      Promise.reject(new Error('synthetic archive failure'))
    );

    await archiveJob!.run({}).result;

    expect(evidence.checkCsamArchiveEvidence).toHaveBeenCalledTimes(1);
    expect(evidence.checkCsamArchiveEvidence.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.archiveCsamDataForReport.mock.invocationCallOrder.at(-1)!
    );
  });

  it('finishes the job when the evidence check fails', async () => {
    evidence.checkCsamArchiveEvidence.mockRejectedValueOnce(new Error('synthetic check failure'));

    await expect(archiveJob!.run({}).result).resolves.not.toThrow();
  });
});

describe('the archive job asks for a lock that can hold a real archival pass', () => {
  // The hazard this pins: the run-jobs route hard-caps the hold at `lockExpiration` and then
  // releases the lock while the run continues, so a value shorter than a pass lets a later
  // hourly tick start a second, competing archive of the same report. Reverting the override
  // must fail here, not be discovered in production.
  //
  // 🔴 `options.dedicated` is DELIBERATELY NOT ASSERTED HERE. It reads like a duplicate-run
  // mitigation and is not one: nothing in the tree reads it (grep `options.dedicated`), so a test
  // pinning it to `true` would report coverage of a field whose value cannot change any behaviour.
  // See the note on `JobOptions.dedicated`.

  it('is the named constant, not createJob’s inherited default', () => {
    const inherited = createJob('probe', '20 */1 * * *', async () => undefined);

    expect(archiveJob!.options.lockExpiration).toBe(CSAM_ARCHIVE_JOB_LOCK_SECONDS);
    // The non-vacuous half: an "override" that is not actually longer than the inherited default
    // leaves the duplicate-run hazard exactly where it was.
    expect(CSAM_ARCHIVE_JOB_LOCK_SECONDS).toBeGreaterThan(inherited.options.lockExpiration);
  });

  it('outlives the cron period it is scheduled on', () => {
    // Asserting the schedule as well as the number is what makes this a RELATIONSHIP rather than
    // two independent literals: if the cron is ever made faster or slower, this fails instead of
    // silently comparing the lock against a period the job no longer runs at.
    expect(archiveJob!.cron).toBe('20 */1 * * *'); // hourly
    const cronPeriodSeconds = 60 * 60;

    // Below this the job can overlap ITSELF regardless of how long any single report takes.
    expect(CSAM_ARCHIVE_JOB_LOCK_SECONDS).toBeGreaterThan(cronPeriodSeconds);
  });

  it('🔴 clears the MEASURED pass with headroom, not merely the cron period', () => {
    // Why the cron-period guard above is not enough on its own: it, and both guards before it, are
    // satisfied by 3601 — one second over the hour, and a fraction of a pass that has actually been
    // observed. This is the assertion that ties the constant to the thing it is sized against.
    //
    // The multiple is 2×, and it is a floor rather than a target for two independent reasons, both
    // recorded on CSAM_ARCHIVE_MEASURED_PASS_SECONDS: the measurement is a single-REPORT time while
    // a tick archives the whole outstanding batch serially, and one observation says nothing about
    // the tail. 2× is the least headroom the sizing argument can be read as claiming.
    //
    // 🔴 The yardstick is pinned to its literal first, and that is what makes the ratio below a
    // guard at all. Both operands live in `process-csam.ts`; with only the lock pinned, shrinking
    // the measurement satisfies the ratio for any lock value, so the exact mutant this case exists
    // to kill — a lock cut back to just over the cron period — survives a one-token edit to the
    // constant it is supposedly measured against. Re-measuring the pass must land here and force
    // the lock to be re-argued, not silently re-baseline the headroom it is checked with.
    expect(CSAM_ARCHIVE_MEASURED_PASS_SECONDS).toBe(80 * 60);
    expect(CSAM_ARCHIVE_JOB_LOCK_SECONDS).toBeGreaterThanOrEqual(
      2 * CSAM_ARCHIVE_MEASURED_PASS_SECONDS
    );

    // The other direction, which `keepLockOnDisconnect` made a real cost: an alive-but-wedged run
    // now holds this lock for its full duration and archival does not resume until it expires.
    // Growing the value without revisiting that trade-off should fail here.
    expect(CSAM_ARCHIVE_JOB_LOCK_SECONDS).toBeLessThanOrEqual(8 * 60 * 60);
  });
});

describe('the CSAM jobs’ locks survive the caller hanging up', () => {
  // 🔴 THE HALF THAT MAKES THE CONSTANT ABOVE MEAN ANYTHING. The caller holds the trigger request
  // open under a client-side timeout and retries; a pass longer than that timeout loses its socket.
  // On the default path the route's close handler releases the lock there and then — throwing the
  // whole `lockExpiration` budget away in exactly the case it was sized for — and the retry starts
  // the competing pass. These cases drive the REAL handler the route installs, using this job's own
  // options object, so they fail if the opt-in is dropped from the job OR broken in the factory.
  //
  // The generic contract, both arms, plus the route-wiring check: `job-disconnect-lock.test.ts`.

  function harness(options: Parameters<typeof createDisconnectHandler>[0]) {
    const cancel = vi.fn(async () => undefined);
    const release = vi.fn(async () => undefined);
    return { cancel, release, handler: createDisconnectHandler(options, { cancel }, { release }) };
  }

  it('a disconnect cancels the context but leaves the lock held', async () => {
    const { cancel, release, handler } = harness(archiveJob!.options);

    await handler();

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
  });

  it('the send job keeps its lock on a disconnect too, and holds it as long', async () => {
    const { release, handler } = harness(sendJob!.options);

    await handler();

    expect(release).not.toHaveBeenCalled();
    expect(sendJob!.options.lockExpiration).toBe(CSAM_SEND_JOB_LOCK_SECONDS);
    // Shorter than the hourly cron, or than the default, and two runs can overlap on one report.
    const inherited = createJob('probe', '0 */1 * * *', async () => undefined);
    expect(sendJob!.cron).toBe('0 */1 * * *');
    expect(CSAM_SEND_JOB_LOCK_SECONDS).toBeGreaterThan(60 * 60);
    expect(CSAM_SEND_JOB_LOCK_SECONDS).toBeGreaterThan(inherited.options.lockExpiration);
  });

  it('CONTROL: a job that does not opt in still releases on a disconnect', async () => {
    const unopted = createJob('probe', '0 */1 * * *', async () => undefined);
    expect(unopted.options.keepLockOnDisconnect).toBeUndefined();
    const { cancel, release, handler } = harness(unopted.options);

    await handler();

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe('send-csam-reports batch isolation', () => {
  it('continues the batch when a report rejects with a non-Error value', async () => {
    // The identical shape in the sibling loop. Fixing one and not the other would leave the
    // batch-abort live on the path that actually files the NCMEC report.
    mocks.processCsamReport.mockImplementationOnce(rejectWithUndefined);

    await expect(sendJob!.run({}).result).resolves.not.toThrow();

    expect(mocks.processCsamReport).toHaveBeenCalledTimes(reports.length);
    const logged = loggingMock.logToAxiom.mock.calls
      .map(([arg]) => arg as { subType?: string; message?: unknown })
      .filter((arg) => arg?.subType === 'send-report');
    expect(logged).toHaveLength(1);
    expect(logged[0].message).toBe('undefined');
  });

  it("names the report that failed, and its open CyberTip, on the batch's error line", async () => {
    mocks.getCsamsToReport.mockResolvedValueOnce([{ id: 8801 }, { id: 8802, reportId: 4401 }]);
    mocks.processCsamReport
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('http status 500 - ServerError'));

    await sendJob!.run({}).result;

    expect(
      loggingMock.logToAxiom.mock.calls
        .map(([arg]) => arg as { subType?: string })
        .filter((arg) => arg?.subType === 'send-report')
    ).toEqual([
      expect.objectContaining({
        message: 'http status 500 - ServerError',
        reportId: 8802,
        ncmecReportId: 4401,
      }),
    ]);
  });
});

describe('send-csam-reports scratch sweep', () => {
  it('sweeps before the first report is claimed', async () => {
    await sendJob!.run({}).result;
    expect(mocks.sweepStaleSendDirs.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.processCsamReport.mock.invocationCallOrder[0]
    );
  });

  it('still sends every report when the sweep fails, and logs the failure', async () => {
    mocks.sweepStaleSendDirs.mockRejectedValueOnce(new Error('EACCES'));

    await sendJob!.run({}).result;

    expect(mocks.processCsamReport).toHaveBeenCalledTimes(reports.length);
    const logged = loggingMock.logToAxiom.mock.calls
      .map(([arg]) => arg as { subType?: string; message?: unknown })
      .filter((arg) => arg?.subType === 'send-scratch-sweep');
    expect(logged).toEqual([expect.objectContaining({ message: 'EACCES' })]);
  });
});

describe('archive-csam-reports scratch sweep', () => {
  it('sweeps before the first report is archived', async () => {
    await archiveJob!.run({}).result;
    expect(mocks.sweepArchiveScratchDirs).toHaveBeenCalledTimes(1);
    expect(mocks.sweepArchiveScratchDirs.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.archiveCsamDataForReport.mock.invocationCallOrder[0]
    );
  });

  it('still archives every report when the sweep fails, and logs the failure', async () => {
    mocks.sweepArchiveScratchDirs.mockRejectedValueOnce(new Error('EACCES'));

    await archiveJob!.run({}).result;

    expect(mocks.archiveCsamDataForReport).toHaveBeenCalledTimes(reports.length);
    const logged = loggingMock.logToAxiom.mock.calls
      .map(([arg]) => arg as { subType?: string; message?: unknown })
      .filter((arg) => arg?.subType === 'archive-scratch-sweep');
    expect(logged).toEqual([expect.objectContaining({ message: 'EACCES' })]);
  });
});

describe('send-csam-reports blocked-report alert', () => {
  it('checks every fetched report after the batch, even when one failed', async () => {
    mocks.processCsamReport.mockRejectedValueOnce(new Error('synthetic send failure'));

    await sendJob!.run({}).result;

    expect(mocks.logBlockedCsamReports).toHaveBeenCalledTimes(1);
    expect(mocks.logBlockedCsamReports).toHaveBeenCalledWith([8801, 8802, 8803]);
    expect(mocks.logBlockedCsamReports.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.processCsamReport.mock.invocationCallOrder.at(-1)!
    );
  });

  it('finishes the job when the check fails', async () => {
    mocks.logBlockedCsamReports.mockRejectedValueOnce(new Error('synthetic check failure'));

    await expect(sendJob!.run({}).result).resolves.not.toThrow();
  });
});

describe('archive-csam-reports and the separate archiver', () => {
  const withUsers = [
    { id: 8801, userId: 501 },
    { id: 8802, userId: 502 },
    { id: 8803, userId: null },
  ];
  const archived = () =>
    mocks.archiveCsamDataForReport.mock.calls.map(([r]) => (r as { id: number }).id);
  const logs = (subType: string) =>
    loggingMock.logToAxiom.mock.calls
      .map(([arg]) => arg as Record<string, unknown>)
      .filter((arg) => arg?.subType === subType);
  const pl = (t: Record<string, unknown>) =>
    t.payload as { tickId: string; inAppOn: boolean; readable: boolean };

  beforeEach(() => mocks.getCsamsToArchive.mockResolvedValue(withUsers));

  it('ON: skips a report the archiver queued after the list was read, checked just before its turn', async () => {
    // The archiver's backfill queues 8802 while 8801 is being archived.
    mocks.archiveCsamDataForReport.mockImplementation(async (r: { id: number }) => {
      if (r.id === 8801) sw.queued.add(8802);
    });

    await archiveJob!.run({}).result;

    expect(archived()).toEqual([8801, 8803]);
    // The null-user report needs no lookup: nothing queues it.
    expect(sw.archiveQueueStates.mock.calls.map(([, ids]) => ids)).toEqual([[8801], [8802]]);
    // On the primary, with the queue's own overdue window.
    for (const [db, , minutes] of sw.archiveQueueStates.mock.calls) {
      expect(db).toBe(kyselyWrite);
      expect(minutes).toBe(JOB_QUEUE_OVERDUE_MINUTES.CsamArchive);
    }
  });

  it('ON: also skips a report whose queue row is failing or overdue: the archiver owns it while its row exists', async () => {
    sw.archiveQueueStates.mockImplementation(
      async (_db: unknown, ids: number[]) =>
        new Map(ids.map((id) => [id, id === 8801 ? 'failing' : 'overdue']))
    );
    await archiveJob!.run({}).result;
    expect(archived()).toEqual([8803]);
  });

  it('OFF: archives only the report with no user', async () => {
    sw.flag = false;
    await archiveJob!.run({}).result;
    expect(archived()).toEqual([8803]);
  });

  it('an unreadable flag runs as ON, alerts, and lists each report it stamped', async () => {
    sw.flag = null;
    sw.stamped = new Set([8801]);
    await archiveJob!.run({}).result;

    expect(archived()).toEqual([8801, 8802, 8803]);
    const unreadable = logs('archive-flag-unreadable');
    expect(unreadable.filter((l) => l.reportId === undefined)).toHaveLength(1);
    expect(unreadable.filter((l) => l.reportId !== undefined).map((l) => l.reportId)).toEqual([
      8801,
    ]);
    expect(unreadable.every((l) => l.type === 'error')).toBe(true);
    // civitai-prod is at Axiom's field cap: a new top-level key would be dropped on ingest.
    expect(unreadable.map((l) => Object.keys(l).sort())).toEqual([
      ['name', 'payload', 'pod', 'subType', 'type'],
      ['name', 'payload', 'pod', 'reportId', 'subType', 'type'],
    ]);
    // The stamp read-back reads archivedAt by report id.
    expect(sw.stampReads).toEqual([
      ['CsamReport', 'archivedAt', 'id', '=', 8801],
      ['CsamReport', 'archivedAt', 'id', '=', 8802],
      ['CsamReport', 'archivedAt', 'id', '=', 8803],
    ]);
  });

  it('under an unreadable flag, a stamp read-back that fails still lists the report', async () => {
    sw.flag = null;
    sw.stampFails = new Set([8802]);
    await archiveJob!.run({}).result;

    const listed = logs('archive-flag-unreadable').filter((l) => l.reportId !== undefined);
    expect(listed.map((l) => l.reportId)).toEqual([8802]);
    // The archive itself succeeded: nothing reports it as failed.
    expect(logs('archive-data')).toEqual([]);
  });

  it('a Flipt init that throws runs the tick as ON and logs the flag as unreadable', async () => {
    sw.flag = false;
    sw.initFails = true;
    await archiveJob!.run({}).result;

    expect(archived()).toEqual([8801, 8802, 8803]);
    expect(logs('archive-tick').map((t) => [t.phase, pl(t).inAppOn, pl(t).readable])).toEqual([
      ['start', true, false],
      ['end', true, false],
    ]);
  });

  it('control: a readable flag logs nothing as unreadable', async () => {
    sw.stamped = new Set([8801]);
    await archiveJob!.run({}).result;
    expect(logs('archive-flag-unreadable')).toEqual([]);
  });

  it('a failed queue lookup leaves the report for the next tick, logged by id and class only', async () => {
    sw.archiveQueueStates.mockImplementation(async (_db: unknown, ids: number[]) => {
      if (ids[0] === 8802)
        throw Object.assign(new Error('synthetic lookup failure'), { name: 'DatabaseError' });
      return new Map();
    });
    await archiveJob!.run({}).result;

    expect(archived()).toEqual([8801, 8803]);
    expect(logs('archive-queue-lookup')).toEqual([
      {
        name: 'csam-report',
        type: 'error',
        subType: 'archive-queue-lookup',
        reportId: 8802,
        error: 'DatabaseError',
      },
    ]);
  });

  it('logs the tick start and end with the flag reading, even when the tick throws', async () => {
    sw.flag = false;
    mocks.getCsamsToArchive.mockRejectedValueOnce(new Error('synthetic list failure'));
    await expect(archiveJob!.run({}).result).rejects.toThrow('synthetic list failure');

    const ticks = logs('archive-tick');
    expect(ticks.map((t) => t.phase)).toEqual(['start', 'end']);
    expect(ticks.every((t) => pl(t).inAppOn === false && pl(t).readable === true)).toBe(true);
    expect(pl(ticks[0]).tickId).toBe(pl(ticks[1]).tickId);
    expect(pl(ticks[0]).tickId).toMatch(/^[0-9a-f-]{36}$/);
    // civitai-prod is at Axiom's field cap: a new top-level key would be dropped on ingest.
    for (const t of ticks)
      expect(Object.keys(t).sort()).toEqual(['name', 'payload', 'phase', 'pod', 'subType', 'type']);
  });
});
