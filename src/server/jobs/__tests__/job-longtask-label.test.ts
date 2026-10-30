import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// WHY THIS TEST EXISTS
//
// Long-task attribution covered tRPC procedures and one REST route, so a cron job
// that blocks the JS thread for seconds attributed to nothing at all — the labeled
// view simply had no `job:*` series to rank. createJob now opens the same ALS scope
// the other two entry points use, gated on the labels tier so the disarmed path is
// byte-for-byte the original direct call.
//
// The armed case is proven through the REAL async_hooks hook (not a spy on
// runWithLongTaskLabel): a spy would pass even if the label never propagated into
// the job's own async resources, which is exactly the failure mode of #2451.
// ---------------------------------------------------------------------------

const { mockDbWrite } = vi.hoisted(() => ({
  mockDbWrite: { keyValue: { findUnique: vi.fn(), upsert: vi.fn() } },
}));
vi.mock('~/server/db/client', () => ({ dbWrite: mockDbWrite, dbRead: mockDbWrite }));

import { createJob } from '~/server/jobs/job';
import {
  __setLongTaskLabelsArmedForTests,
  __installLabelHookForTests,
  __hasActiveLabelStoreForTests,
} from '~/server/eventloop-longtask';

const busyWait = (ms: number) => {
  const end = Date.now() + ms;
  // eslint-disable-next-line no-empty
  while (Date.now() < end) {}
};

describe('cron jobs carry a long-task attribution label', () => {
  it('attributes a block inside a job to job:<name> when the labels tier is armed', async () => {
    const restore = __setLongTaskLabelsArmedForTests(true);
    const recorded: Array<{ dur: number; label: string }> = [];
    const teardown = __installLabelHookForTests(20, 10_000, (dur, label) =>
      recorded.push({ dur, label })
    );

    try {
      const job = createJob(
        'metrics-update',
        '0 * * * *',
        () =>
          new Promise<void>((resolve) => {
            // A timer created inside the job's ALS scope; its callback blocks the
            // loop — the request->resource shape the hook attributes from.
            setTimeout(() => {
              busyWait(60);
              resolve();
            }, 5);
          })
      );
      await job.run({}).result;
      await new Promise<void>((r) => setTimeout(r, 20));
    } finally {
      teardown();
      restore();
    }

    const labeled = recorded.find((r) => r.label === 'job:metrics-update');
    expect(
      labeled,
      `expected a job:metrics-update block, got: ${JSON.stringify(recorded)}`
    ).toBeTruthy();
    expect(recorded.find((r) => r.label === 'unlabeled')).toBeUndefined();
  });

  // INVARIANT GUARD, not regression coverage for the `longTaskLabelsArmed` call-site
  // gate: runWithLongTaskLabel short-circuits internally too, so deleting the gate
  // leaves this green (verified by mutation). What it does pin is the tier contract —
  // a disarmed job propagates no async context — reported as a PAIR so the disarmed
  // `false` is not a zero from a probe wired to nothing.
  async function storeActiveInsideJob(armed: boolean): Promise<boolean | undefined> {
    const restore = __setLongTaskLabelsArmedForTests(armed);
    let seen: boolean | undefined;
    try {
      const job = createJob('metrics-update', '0 * * * *', async () => {
        seen = __hasActiveLabelStoreForTests();
      });
      await job.run({}).result;
    } finally {
      restore();
    }
    return seen;
  }

  it('propagates an ALS scope into the job only while the labels tier is armed', async () => {
    expect(await storeActiveInsideJob(true)).toBe(true);
    expect(await storeActiveInsideJob(false)).toBe(false);
  });

  it('still returns the job result and still propagates a job failure', async () => {
    const restore = __setLongTaskLabelsArmedForTests(true);
    try {
      const ok = createJob('ok-job', '0 * * * *', async () => ({ done: true }));
      await expect(ok.run({}).result).resolves.toEqual({ done: true });

      const bad = createJob('bad-job', '0 * * * *', async () => {
        throw new Error('boom');
      });
      await expect(bad.run({}).result).rejects.toThrow('boom');
    } finally {
      restore();
    }
  });
});
