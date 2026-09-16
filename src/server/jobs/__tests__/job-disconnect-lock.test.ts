import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { createDisconnectHandler, createJob } from '~/server/jobs/job';

/**
 * What happens to a job's redis lock when the client that triggered the run hangs up.
 *
 * THE HAZARD. The external scheduler holds the trigger request open and gives it a client-side
 * timeout, then retries. Historically the route's close handler released the lock, so a run longer
 * than that timeout lost its lock at the disconnect no matter how large `lockExpiration` was — and
 * the retry then acquired the freed lock and started a second, competing run of the same work.
 * `keepLockOnDisconnect` is the opt-out from that release. This file pins BOTH arms: that the flag
 * changes the handler, and that its absence leaves the historical behaviour byte-for-byte intact.
 *
 * The assertions drive the REAL factory the route installs, with spies standing in only for the
 * runner and the lock. The route itself imports every job in the application and so cannot be
 * loaded here; the last case below checks the wiring against the route's source instead, and says
 * what that is and is not worth.
 */

const RUN_JOBS_ROUTE = path.resolve(
  __dirname,
  '../../../pages/api/webhooks/run-jobs/[[...run]].ts'
);

function harness(options: Parameters<typeof createDisconnectHandler>[0]) {
  const cancel = vi.fn(async () => undefined);
  const release = vi.fn(async () => undefined);
  return { cancel, release, handler: createDisconnectHandler(options, { cancel }, { release }) };
}

describe('a client disconnect releases the job lock unless the job opted out', () => {
  it('DEFAULT (option absent): cancels the context AND releases the lock', async () => {
    // The pre-existing behaviour, and the one every job in the tree but the opted-in ones gets.
    const { cancel, release, handler } = harness({});

    await handler();

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    // Counts alone leave the ORDER free: releasing before the context is canceled hands the lock
    // back while the run is still live and not yet told to stop, which is the window the retry
    // needs to start a competing run. Inverting the two awaits keeps both counts at 1.
    expect(cancel.mock.invocationCallOrder[0]).toBeLessThan(release.mock.invocationCallOrder[0]);
  });

  it('DEFAULT (option explicitly false): still releases', async () => {
    // `false` must be indistinguishable from absent — a job that writes the field out to say "no"
    // must not accidentally get the opt-in.
    const { cancel, release, handler } = harness({ keepLockOnDisconnect: false });

    await handler();

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('OPT-IN: cancels the context but does NOT release the lock', async () => {
    const { cancel, release, handler } = harness({ keepLockOnDisconnect: true });

    await handler();

    // Cancel still fires: the flag is about the LOCK, not about whether jobs that poll
    // `checkIfCanceled` are told to stop. Dropping the cancel would silently change every
    // cancellation-aware job that ever adopts this option.
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
  });

  it('a job built by createJob without the option gets the releasing handler', async () => {
    // The default arrives via `createJob`'s option spread, not just via a hand-written literal —
    // this is the path a real job's `options` object actually takes.
    const job = createJob('probe-disconnect-default', '20 */1 * * *', async () => undefined);
    const { cancel, release, handler } = harness(job.options);

    expect(job.options.keepLockOnDisconnect).toBeUndefined();
    await handler();

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('a job built by createJob WITH the option gets the holding handler', async () => {
    const job = createJob('probe-disconnect-optin', '20 */1 * * *', async () => undefined, {
      keepLockOnDisconnect: true,
    });
    const { cancel, release, handler } = harness(job.options);

    await handler();

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
  });
});

describe('the run-jobs route builds its close handler from this factory', () => {
  it('installs createDisconnectHandler(options, jobRunner, lock) as the close handler', () => {
    // 🔴 WHAT THIS IS: a source read, because importing that route pulls in every job in the
    // application. WHAT IT IS WORTH: it catches the route re-inlining the two awaits, and it
    // catches the registration being moved to where it can never fire during a run — either of
    // which would leave every test above green while the option did nothing in production. It
    // cannot tell you the handler behaves correctly; the cases above do that, and it cannot tell
    // you the handler is ever removed again, which nothing here checks.
    const source = readFileSync(RUN_JOBS_ROUTE, 'utf8');

    expect(source).toContain(
      'const cancelHandler = createDisconnectHandler(options, jobRunner, lock);'
    );
    expect(source).toContain("res.on('close', cancelHandler)");
    // Presence is not the mechanism — POSITION is. Registered after the run is awaited, the
    // handler is installed only once the run it was meant to protect has already finished: the
    // opt-in becomes inert AND every other job silently loses its disconnect release, with the
    // substring above still present.
    expect(source.indexOf("res.on('close', cancelHandler)")).toBeLessThan(
      source.indexOf('result = await jobRunner.result')
    );
    // The `options` passed above must be the dispatched job's, not a literal.
    expect(source).toContain('const { name, run, options } = job;');
  });
});
