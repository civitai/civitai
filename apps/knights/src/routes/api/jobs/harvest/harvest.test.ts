import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredSettings } from '$lib/server/settings/stored';

const stored = vi.hoisted(() => ({ current: {} as StoredSettings }));
const runHarvestJob = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/jobs-auth', () => ({ isJobRequest: () => true }));
vi.mock('$lib/server/trials/harvest.service', () => ({ runHarvestJob }));
vi.mock('$lib/server/settings/runtime', () => ({ storedSettings: async () => stored.current }));

const { POST } = await import('./+server');

const run = () => POST({ request: new Request('http://knights.test/api/jobs/harvest') } as never);

describe('the harvest job', () => {
  beforeEach(() => {
    runHarvestJob.mockReset().mockResolvedValue({ ok: true });
    stored.current = {};
    delete process.env.KNIGHTS_HARVEST;
    delete process.env.KNIGHTS_HARVEST_HIDDEN_CHECK_SHARE;
    delete process.env.KNIGHTS_HIDDEN_CHECK_PROBATION_SHARE;
  });
  afterEach(() => {
    delete process.env.KNIGHTS_HARVEST;
    delete process.env.KNIGHTS_HARVEST_HIDDEN_CHECK_SHARE;
    delete process.env.KNIGHTS_HIDDEN_CHECK_PROBATION_SHARE;
  });

  it('passes the probation share to the job, 0 when unset', async () => {
    await run();
    process.env.KNIGHTS_HIDDEN_CHECK_PROBATION_SHARE = '0.25';
    await run();
    expect(runHarvestJob.mock.calls.map((call) => call[1].probationShare)).toEqual([0, 0.25]);
  });

  it('runs on the environment when nothing is saved', async () => {
    process.env.KNIGHTS_HARVEST = 'off';
    process.env.KNIGHTS_HARVEST_HIDDEN_CHECK_SHARE = '0.2';
    await run();
    expect(runHarvestJob.mock.calls[0][1].settings).toEqual({
      paused: true,
      hiddenCheckShare: 0.2,
    });
  });

  it('reads the saved settings on every run, over the environment', async () => {
    process.env.KNIGHTS_HARVEST = 'off';
    stored.current = { harvest: true, harvestHiddenCheckShare: 0.5 };
    await run();
    stored.current = { harvest: false };
    await run();
    expect(runHarvestJob.mock.calls.map((call) => call[1].settings)).toEqual([
      { paused: false, hiddenCheckShare: 0.5 },
      { paused: true, hiddenCheckShare: 0 },
    ]);
  });
});