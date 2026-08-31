import { describe, expect, it, vi } from 'vitest';
import client from 'prom-client';

// 🔴 WHY THIS FILE MOCKS `~/server/prom/client` WITH THE REAL PACKAGE.
//
// The shared setup replaces that module wholesale with call-recording stubs, so under the
// default harness `jobDurationHistogram` is a `vi.fn()` bag and there is no registry to
// read. A test written against that could only assert that createJob CALLED something —
// which is a claim about the fake, not about what a scrape returns, and would stay green
// if the metric were registered on a registry nobody serves.
//
// The app shim's only unsafe part is the DB-pool glue it builds at module scope; the two
// job metrics come from '@civitai/telemetry/client', which imports nothing but prom-client.
// Substituting the real package therefore gives real metrics on prom-client's real default
// registry — the same registry `src/pages/api/metrics.ts` renders — so every assertion
// below reads actual Prometheus exposition text rather than a mock's call log.
vi.mock('~/server/prom/client', async () => await import('@civitai/telemetry/client'));

import { createJob } from '~/server/jobs/job';
// A REAL job, imported for its own sake: `scan-files-fallback` is created at this module's
// top level, which is exactly how all ~146 jobs are created and the only place the seeding
// can run. Asserting on a job the test itself declares would not prove that.
import { scanFilesFallbackJob } from '~/server/jobs/scan-files';

/** The scraped `/metrics` body, as Prometheus would receive it. */
async function scrape() {
  return await client.register.metrics();
}

function sampleLinesFor(text: string, job: string) {
  return text.split('\n').filter((l) => !l.startsWith('#') && l.includes(`job="${job}"`));
}

describe('cron job metrics are exposed on the scraped endpoint', () => {
  it('exposes a zero-valued series for a real job that has never run (scan-files-fallback)', async () => {
    const text = await scrape();

    // The two lines a dashboard or alert actually reads. Pinned as whole normalised
    // strings — including the trailing ` 0` — because a guard that only checked the
    // metric NAME would pass on a series carrying any value, and a guard that only
    // checked "some line mentions this job" would pass on the `_bucket` lines alone.
    expect(text).toContain('civitai_app_job_duration_seconds_count{job="scan-files-fallback"} 0');
    expect(text).toContain('civitai_app_job_errors_total{job="scan-files-fallback"} 0');

    // Sanity: the name asserted above is the job's real registered name, not a literal
    // that drifted away from the code.
    expect(scanFilesFallbackJob.name).toBe('scan-files-fallback');
  });

  it('exposes the full histogram (every bucket + sum + count) so rate()/histogram_quantile have a series to read', async () => {
    const text = await scrape();
    const lines = sampleLinesFor(text, 'scan-files-fallback');

    // 10 declared buckets + `+Inf` + `_sum` + `_count` + the errors counter = 14.
    // An exact count, not a lower bound: a partially-seeded histogram is a real failure
    // mode (`zero()` writing an empty bucket map would still satisfy `toContain` on the
    // `_count` line above), and only counting catches it.
    expect(lines).toHaveLength(14);
    for (const bucket of [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300]) {
      expect(text).toContain(
        `civitai_app_job_duration_seconds_bucket{le="${bucket}",job="scan-files-fallback"} 0`
      );
    }
    expect(text).toContain(
      'civitai_app_job_duration_seconds_bucket{le="+Inf",job="scan-files-fallback"} 0'
    );
    expect(text).toContain('civitai_app_job_duration_seconds_sum{job="scan-files-fallback"} 0');
  });

  it('does it for EVERY job createJob builds, not just the one job under test', async () => {
    // The defect is a class: any job whose module has been loaded must be observable, and
    // a job-specific fix would leave the other ~145 invisible. Three fresh names, created
    // exactly as a job module creates them.
    const names = ['class-probe-alpha', 'class-probe-beta', 'class-probe-gamma'];
    for (const name of names) createJob(name, '* * * * *', async () => undefined);

    const text = await scrape();
    for (const name of names) {
      expect(text).toContain(`civitai_app_job_duration_seconds_count{job="${name}"} 0`);
      expect(text).toContain(`civitai_app_job_errors_total{job="${name}"} 0`);
    }
  });

  it('NEGATIVE CONTROL: a label value no job ever declared emits nothing', async () => {
    // Proves the assertions above are observing the seeding rather than some blanket
    // property of the metric — a labelled prom-client metric emits NO series for an
    // unseen label value, which is the mechanism this whole change exists to fix. If this
    // ever starts matching, the tests above have stopped discriminating.
    const text = await scrape();
    expect(text).not.toContain('job="a-job-that-was-never-created"');
    expect(sampleLinesFor(text, 'a-job-that-was-never-created')).toHaveLength(0);
  });

  it('seeding does not clobber a real observation: a completed run still increments _count', async () => {
    const job = createJob('observed-probe-job', '* * * * *', async () => undefined);

    const before = await scrape();
    expect(before).toContain('civitai_app_job_duration_seconds_count{job="observed-probe-job"} 0');

    await job.run({}).result;

    const after = await scrape();
    expect(after).toContain('civitai_app_job_duration_seconds_count{job="observed-probe-job"} 1');
    // A successful run must not touch the error counter — it stays an observable zero.
    expect(after).toContain('civitai_app_job_errors_total{job="observed-probe-job"} 0');
  });

  it('a throwing run increments the (already-seeded) error counter', async () => {
    const job = createJob('failing-probe-job', '* * * * *', async () => {
      throw new Error('boom');
    });

    await expect(job.run({}).result).rejects.toThrow('boom');

    const after = await scrape();
    expect(after).toContain('civitai_app_job_errors_total{job="failing-probe-job"} 1');
    expect(after).toContain('civitai_app_job_duration_seconds_count{job="failing-probe-job"} 1');
  });
});
