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
  getCsamsToRemoveContent: vi.fn(async () => []),
}));

vi.mock('~/server/services/csam.service-new', () => mocks);

import { CSAM_ARCHIVE_JOB_LOCK_SECONDS, csamJobs } from '~/server/jobs/process-csam';
import { createJob } from '~/server/jobs/job';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const archiveJob = csamJobs.find((job) => job.name === 'archive-csam-reports');
const sendJob = csamJobs.find((job) => job.name === 'send-csam-reports');

const reports = [{ id: 8801 }, { id: 8802 }, { id: 8803 }];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCsamsToArchive.mockResolvedValue(reports);
  mocks.getCsamsToReport.mockResolvedValue(reports);
  mocks.archiveCsamDataForReport.mockResolvedValue(undefined);
  mocks.processCsamReport.mockResolvedValue(undefined);
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
});

describe('the archive job asks for a lock that can hold a real archival pass', () => {
  // The hazard this pins: the run-jobs route hard-caps the hold at `lockExpiration` and then
  // releases the lock while the run continues, so a value shorter than a pass lets the next
  // hourly tick start a second, concurrent archive of the same report. Reverting the override
  // must fail here, not be discovered in production.

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

  it('keeps the single-pod restriction, which the lock does not replace', () => {
    // `dedicated` bounds WHERE the job runs; the lock bounds WHETHER a second run may start.
    // Adding the lock must not cost the other half.
    expect(archiveJob!.options.dedicated).toBe(true);
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
});
