import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_RELABEL_BATCH_ITEMS,
  MAX_RELABEL_WINDOW_DAYS,
  RELABEL_DAILY_CAPS,
  RELABEL_WINDOW_DAYS,
  relabelBuildBatchInput,
  type RelabelBuildBatchInput,
} from '@civitai/moderation';
import { BLOCKED_IMAGE_RETENTION_DAYS } from '@civitai/shared/job-queue';
import { relabelBuildBatchJob, runRelabelBuildBatch } from '~/server/jobs/relabel-build-batch';

const RUN_JOBS_ROUTE = path.resolve(
  __dirname,
  '../../../pages/api/webhooks/run-jobs/[[...run]].ts'
);

async function run(now: Date) {
  const send = vi.fn<(input: RelabelBuildBatchInput) => Promise<unknown>>(async () => ({
    inserted: 3,
  }));
  const log = vi.fn();
  await runRelabelBuildBatch({ now, send, log });
  expect(send).toHaveBeenCalledTimes(1);
  return { input: send.mock.calls[0][0], log };
}

/** The `jobs` array the route dispatches on, as source lines, comments dropped. */
function jobsArrayEntries(): string[] {
  const source = readFileSync(RUN_JOBS_ROUTE, 'utf8');
  const start = source.indexOf('export const jobs: Job[] = [');
  if (start === -1) throw new Error(`no \`jobs\` array in ${RUN_JOBS_ROUTE}`);
  const end = source.indexOf('\n];', start);
  if (end === -1) throw new Error(`unterminated \`jobs\` array in ${RUN_JOBS_ROUTE}`);
  return source
    .slice(start, end)
    .split('\n')
    .map((line) => line.trim().replace(/,$/, ''))
    .filter((line) => line.length > 0 && !line.startsWith('//'));
}

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
  // name the same batch whatever the server's zone.
  it('names one batch for every fire within a UTC day', async () => {
    expect((await run(new Date('2026-10-03T17:00:00-07:00'))).input.batch).toBe('2026-10-04');
    expect((await run(new Date('2026-10-04T23:59:59Z'))).input.batch).toBe('2026-10-04');
  });

  it("logs the spoke's counts", async () => {
    const { log } = await run(new Date('2026-10-04T00:30:00Z'));
    expect(log).toHaveBeenCalledWith({ batch: '2026-10-04', result: { inserted: 3 } });
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
