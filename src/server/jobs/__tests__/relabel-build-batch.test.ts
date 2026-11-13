import { readFileSync } from 'fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_RELABEL_BATCH_ITEMS,
  MAX_RELABEL_WINDOW_DAYS,
  RELABEL_DAILY_CAPS,
  RELABEL_WINDOW_DAYS,
  modActionResponse,
  relabelBuildBatchInput,
  relabelBuildShortfall,
  type RelabelBuildBatchInput,
  type RelabelBuildSummary,
} from '@civitai/moderation';
import { BLOCKED_IMAGE_RETENTION_DAYS } from '@civitai/shared/job-queue';
import { relabelBuildBatchJob, runRelabelBuildBatch } from '~/server/jobs/relabel-build-batch';
import { RUN_JOBS_ROUTE, jobsArrayEntries } from './run-jobs-array';

const zero = { removed: 0, notRemoved: 0 };
const summary = (over: Partial<RelabelBuildSummary> = {}): RelabelBuildSummary => ({
  batch: '2026-10-04',
  dryRun: false,
  modelOnly: false,
  skipped: null,
  notRemovedSkipped: null,
  candidates: zero,
  csamExcluded: zero,
  alreadyInSet: 0,
  alreadyInBatch: zero,
  picked: zero,
  strata: [],
  inserted: 3,
  promoted: 0,
  alreadyPresent: 0,
  ...over,
});
// Built with the spoke route's own envelope helper, so a change to that shape reaches this test.
const done = modActionResponse(summary());

async function run(now: Date, response: unknown = done) {
  const send = vi.fn<(input: RelabelBuildBatchInput) => Promise<unknown>>(async () => response);
  const log = vi.fn();
  await runRelabelBuildBatch({ now, send, log });
  expect(send).toHaveBeenCalledTimes(1);
  return { input: send.mock.calls[0][0], log };
}

const originalTz = process.env.TZ;
afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe('relabel-build-batch job', () => {
  it('builds for real, under the UTC day, at the daily caps', async () => {
    const { input } = await run(new Date('2026-10-04T00:30:00Z'));
    expect(input).toEqual({
      batch: '2026-10-04',
      removed: RELABEL_DAILY_CAPS.removed,
      notRemoved: RELABEL_DAILY_CAPS.notRemoved,
      days: RELABEL_WINDOW_DAYS,
      dryRun: false,
    });
    expect(relabelBuildBatchInput.safeParse(input).success).toBe(true);
  });

  // The batch name is what makes a same-day re-run add nothing, so two fires on one UTC day must
  // name the same batch whatever the server's zone. Run in a zone where local and UTC dates differ.
  it('names one batch for every fire within a UTC day, in any server zone', async () => {
    process.env.TZ = 'America/Los_Angeles';
    expect(new Date('2026-10-04T00:30:00Z').getDate()).toBe(3);
    expect((await run(new Date('2026-10-04T00:30:00Z'))).input.batch).toBe('2026-10-04');
    expect((await run(new Date('2026-10-04T23:59:59Z'))).input.batch).toBe('2026-10-04');
  });

  it("logs the spoke's counts", async () => {
    const { log } = await run(new Date('2026-10-04T00:30:00Z'));
    expect(log).toHaveBeenCalledWith({
      type: 'info',
      batch: '2026-10-04',
      shortfall: null,
      result: done,
    });
  });

  // A skipped day loses the removals that age out before the next run, and a day without its
  // not-removed half loses that stratum. Neither may read as a green run on this side.
  it('logs a skipped day, or one built without bands it could read, as an error', async () => {
    const skipped = modActionResponse(
      summary({ inserted: 0, skipped: 'csam exclusion timed out' })
    );
    const halved = modActionResponse(summary({ notRemovedSkipped: 'bands invalid' }));
    const at = new Date('2026-10-04T00:30:00Z');
    expect((await run(at, skipped)).log).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', shortfall: 'csam exclusion timed out' })
    );
    expect((await run(at, halved)).log).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', shortfall: 'bands invalid' })
    );
  });

  // The client turns an unparseable 2xx body into `{}`. Nothing says the day was built, so it
  // must not read as one that was.
  it('logs a response with no summary as an error', async () => {
    expect((await run(new Date('2026-10-04T00:30:00Z'), {})).log).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', shortfall: 'no summary' })
    );
  });

  // Unset bands are the approved state until the secret is set: a removed-only day is not a fault.
  it('logs a removed-only day as info while the bands are unset', async () => {
    const unset = modActionResponse(summary({ notRemovedSkipped: 'bands unset' }));
    expect(relabelBuildShortfall(unset)).toBeNull();
    expect((await run(new Date('2026-10-04T00:30:00Z'), unset)).log).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'info' })
    );
  });

  it('draws removals only from images not yet purged, at caps the spoke accepts', () => {
    expect(MAX_RELABEL_WINDOW_DAYS).toBe(BLOCKED_IMAGE_RETENTION_DAYS - 1);
    expect(RELABEL_WINDOW_DAYS).toBeLessThanOrEqual(MAX_RELABEL_WINDOW_DAYS);
    expect(RELABEL_DAILY_CAPS.removed).toBeLessThanOrEqual(MAX_RELABEL_BATCH_ITEMS);
    expect(RELABEL_DAILY_CAPS.notRemoved).toBeLessThanOrEqual(MAX_RELABEL_BATCH_ITEMS);
  });

  it('refuses a window reaching past the purge at the contract, not in the handler', () => {
    const input = {
      batch: '2026-10-04',
      ...RELABEL_DAILY_CAPS,
      days: BLOCKED_IMAGE_RETENTION_DAYS,
      dryRun: true,
    };
    expect(relabelBuildBatchInput.safeParse(input).success).toBe(false);
  });

  // Removed images are hard-deleted 7 days after the block. A cadence slower than daily loses the
  // removals that age out between fires.
  it('fires exactly once a day', () => {
    const fields = relabelBuildBatchJob.cron.trim().split(/\s+/);
    expect(fields).toHaveLength(5);
    const [minute, hour, dom, month, dow] = fields;
    expect(minute).toMatch(/^[0-5]?\d$/);
    expect(hour).toMatch(/^([01]?\d|2[0-3])$/);
    expect([dom, month, dow]).toEqual(['*', '*', '*']);
  });

  it('is in the jobs array the scheduler reads', () => {
    const entries = jobsArrayEntries();
    expect(entries.length).toBeGreaterThan(50);
    expect(entries).toContain('relabelBuildBatchJob');
    expect(readFileSync(RUN_JOBS_ROUTE, 'utf8')).toContain(
      "from '~/server/jobs/relabel-build-batch'"
    );
  });
});
