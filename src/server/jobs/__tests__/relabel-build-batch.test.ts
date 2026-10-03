import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { MAX_RELABEL_BATCH_ITEMS, type RelabelBuildBatchInput } from '@civitai/moderation';
import { BLOCKED_IMAGE_RETENTION_DAYS } from '@civitai/shared/job-queue';
import {
  RELABEL_DAILY_CAPS,
  RELABEL_WINDOW_DAYS,
  relabelBuildBatchJob,
  runRelabelBuildBatch,
} from '~/server/jobs/relabel-build-batch';

const RUN_JOBS_ROUTE = path.resolve(
  __dirname,
  '../../../pages/api/webhooks/run-jobs/[[...run]].ts'
);

async function sent(now: Date) {
  const send = vi.fn(async (_: RelabelBuildBatchInput) => ({ ok: true }));
  await runRelabelBuildBatch({ now, send, log: () => undefined });
  expect(send).toHaveBeenCalledTimes(1);
  return send.mock.calls[0][0];
}

describe('relabel-build-batch job', () => {
  it('builds for real, under the UTC day, at the daily caps', async () => {
    expect(await sent(new Date('2026-10-04T00:30:00Z'))).toEqual({
      batch: '2026-10-04',
      removed: RELABEL_DAILY_CAPS.removed,
      notRemoved: RELABEL_DAILY_CAPS.notRemoved,
      days: RELABEL_WINDOW_DAYS,
      dryRun: false,
    });
  });

  // The batch name is what makes a same-day re-run add nothing, so two fires on one UTC day must
  // name the same batch whatever the server's zone.
  it('names one batch for every fire within a UTC day', async () => {
    const early = await sent(new Date('2026-10-03T17:00:00-07:00'));
    const late = await sent(new Date('2026-10-04T23:59:59Z'));
    expect(early.batch).toBe('2026-10-04');
    expect(late.batch).toBe('2026-10-04');
  });

  it('draws removals only from images not yet purged, at caps the spoke accepts', () => {
    expect(RELABEL_WINDOW_DAYS).toBeLessThan(BLOCKED_IMAGE_RETENTION_DAYS);
    expect(RELABEL_DAILY_CAPS.removed).toBeLessThanOrEqual(MAX_RELABEL_BATCH_ITEMS);
    expect(RELABEL_DAILY_CAPS.notRemoved).toBeLessThanOrEqual(MAX_RELABEL_BATCH_ITEMS);
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
    const source = readFileSync(RUN_JOBS_ROUTE, 'utf8');
    const start = source.indexOf('export const jobs: Job[] = [');
    const end = source.indexOf('\n];', start);
    expect(start).toBeGreaterThan(-1);
    const entries = source
      .slice(start, end)
      .split('\n')
      .map((l) => l.trim().replace(/,$/, ''));
    expect(entries.length).toBeGreaterThan(50);
    expect(entries).toContain('relabelBuildBatchJob');
  });
});
