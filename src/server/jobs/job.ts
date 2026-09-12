import type { NextApiRequest, NextApiResponse } from 'next';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { jobDurationHistogram, jobErrorsCounter, seedJobMetrics } from '~/server/prom/client';
import { longTaskLabelsArmed, runWithLongTaskLabel } from '~/server/eventloop-longtask';
import { applySourceMaps } from '~/server/utils/errorHandling';

export type Job = {
  name: string;
  run: (opts?: { req?: NextApiRequest }) => {
    result: Promise<MixedObject | void>;
    cancel: () => Promise<void>;
  };
  cron: string;
  options: JobOptions;
};

export type JobOptions = {
  shouldWait: boolean;
  lockExpiration: number;
  queue?: string;
  /**
   * Declared intent that the job run on a single pod.
   *
   * 🔴 INERT. Nothing in this tree reads `options.dedicated` — it is set on a handful of jobs,
   * serialised out by `/api/internal/get-jobs`, and dropped by the scheduler's DTO. Setting it
   * changes no behaviour. Left in place as the declaration it is; do not cite it as a
   * duplicate-run mitigation.
   */
  dedicated?: boolean;
  /**
   * Opt-in: when the HTTP client that triggered this run hangs up, cancel the job context but
   * LEAVE THE REDIS LOCK HELD.
   *
   * Absent or `false` — the default for every job — is the historical behaviour: a disconnect
   * cancels AND releases.
   *
   * Why an opt-in exists at all: the external scheduler holds the trigger request open and gives
   * it a client-side timeout. A run that outlives that timeout loses the socket, and releasing on
   * that close throws away the whole `lockExpiration` budget precisely in the case it was sized
   * for — the scheduler's automatic retry then acquires the freed lock and starts a competing
   * second run of the same work. Set this only on jobs that (a) legitimately run longer than the
   * scheduler's client timeout and (b) are harmful to run twice concurrently, and set
   * `lockExpiration` deliberately, because with this on it is the only thing bounding the hold.
   *
   * The cost it buys, stated plainly: a run that is ALIVE BUT WEDGED now holds the lock for the
   * full `lockExpiration` instead of losing it at the disconnect, so the job does not run again
   * until that expires. A pod that DIES does not pay this — the redis key carries a ~10s TTL
   * refreshed by an in-process interval (see `acquireLock` in the run-jobs route), so a dead
   * pod's lock lapses within seconds regardless of this option.
   */
  keepLockOnDisconnect?: boolean;
};

export type JobStatus = 'running' | 'canceled' | 'finished';
export type JobContext = {
  status: JobStatus;
  on: (event: 'cancel', listener: () => Promise<void>) => void;
  checkIfCanceled: () => void;
  req?: NextApiRequest;
};

export function inJobContext(res: NextApiResponse, fn: (jobContext: JobContext) => Promise<void>) {
  const onCancel: (() => Promise<void>)[] = [];
  const jobContext = {
    status: 'running' as JobStatus,
    on: (event: 'cancel', listener: () => Promise<void>) => {
      if (event === 'cancel') onCancel.push(listener);
    },
    checkIfCanceled: () => {
      if (jobContext.status === 'canceled') throw new Error('Job was canceled');
    },
  };
  res.on('close', async () => {
    if (jobContext.status !== 'running') return;
    jobContext.status = 'canceled';
    await Promise.all(onCancel.map((x) => x()));
  });
  return fn(jobContext).finally(() => {
    if (jobContext.status !== 'running') return;
    jobContext.status = 'finished';
  });
}

export function createJob(
  name: string,
  cron: string,
  fn: (e: JobContext) => Promise<MixedObject | void>,
  options: Partial<JobOptions> = {}
) {
  // Publish this job's series at zero NOW, rather than leaving it absent until the job
  // first completes (or first throws). See seedJobMetrics for why an absent series and a
  // healthy zero must be distinguishable here.
  //
  // Guarded because this runs at the MODULE scope of every job file, which the run-jobs
  // route imports eagerly: an exception escaping here would fail that import and take
  // EVERY cron job down. Losing a seeded zero is a legibility regression; losing the
  // route is an outage, so the telemetry must never be able to cause one.
  try {
    seedJobMetrics(name);
  } catch {
    // Intentionally swallowed — see above.
  }

  return {
    name,
    cron,
    run: (props: { req?: NextApiRequest }) => {
      const { req } = props ?? {};

      const onCancel: (() => Promise<void>)[] = [];
      const jobContext = {
        status: 'running' as JobStatus,
        on: (event: 'cancel', listener: () => Promise<void>) => {
          if (event === 'cancel') onCancel.push(listener);
        },
        checkIfCanceled: () => {
          if (jobContext.status !== 'running') throw new Error('Job has ended');
        },
        req,
      };
      const cancel = async () => {
        if (jobContext.status !== 'running') return;
        jobContext.status = 'canceled';
        await Promise.all(onCancel.map((x) => x()));
      };
      const endTimer = jobDurationHistogram.startTimer({ job: name });
      // When the long-task LABELS tier is armed, attribute synchronous event-loop
      // blocks inside this job to `job:<name>`. Costs one AsyncLocalStorage.run() per
      // job invocation and is OFF by default; when disarmed this is the original
      // direct call. See src/server/eventloop-longtask.ts.
      const started = longTaskLabelsArmed
        ? runWithLongTaskLabel(`job:${name}`, () => fn(jobContext))
        : fn(jobContext);
      const result = started
        .catch(async (e) => {
          jobErrorsCounter.inc({ job: name });
          const error = e instanceof Error ? e : undefined;
          const message = typeof e === 'string' ? e : error?.message;
          const stack = error?.stack ? await applySourceMaps(error.stack) : undefined;
          logToAxiom({
            type: 'job-error',
            name,
            message: !stack ? message : undefined,
            stack,
          });
          throw e; // Re-throw to ensure webhook endpoint can handle errors
        })
        .finally(() => {
          endTimer();
          if (jobContext.status === 'canceled') return;
          jobContext.status = 'finished';
        });
      return { result, cancel };
    },
    options: {
      shouldWait: false,
      lockExpiration: 5 * 60,
      ...options,
    },
  } as Job;
}

/**
 * Builds the handler the run-jobs route installs on `res.on('close')` — i.e. what happens when the
 * client that triggered a run hangs up mid-run.
 *
 * It lives here, not inline in the route, for one reason: the route imports every job in the
 * application, so nothing about it can be exercised in a unit test. This is the one decision in
 * that handler that has a behavioural contract worth pinning, so it is extracted to where a test
 * can drive it with a real job's own `options`. The route must keep calling this rather than
 * re-inlining the two awaits — `job-disconnect-lock.test.ts` reads the route source to check that.
 *
 * `cancel()` runs in BOTH branches on purpose. It is what flips the job context to `canceled`, and
 * jobs that poll `checkIfCanceled` must still stop when the caller goes away; `keepLockOnDisconnect`
 * is about the LOCK, not about whether the job is told to stop.
 */
export function createDisconnectHandler(
  options: Pick<JobOptions, 'keepLockOnDisconnect'>,
  jobRunner: { cancel: () => Promise<void> },
  lock: { release: () => Promise<void> }
): () => Promise<void> {
  return async () => {
    await jobRunner.cancel();
    // Default (absent/false): release, exactly as before this option existed.
    if (options.keepLockOnDisconnect) return;
    await lock.release();
  };
}

export async function getJobDate(key: string, defaultValue?: Date) {
  defaultValue ??= new Date(0);
  const stored = await dbWrite.keyValue.findUnique({ where: { key } });
  const date = stored ? new Date(stored.value as number) : defaultValue;

  const newDate = new Date();
  const set = async (date?: Date) => {
    date ??= newDate;
    await dbWrite.keyValue.upsert({
      where: { key },
      create: { key, value: date.getTime() },
      update: { value: date.getTime() },
    });
  };

  return [date, set] as const;
}

// Set on Feb. 31st which will never come.
export const UNRUNNABLE_JOB_CRON = '0 0 5 31 2 ?';
