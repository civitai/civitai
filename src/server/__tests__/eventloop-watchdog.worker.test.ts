import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { WATCHDOG_WORKER_SOURCE } from '~/server/eventloop-watchdog';

// The worker source is an inline string (see the tracing note in
// eventloop-watchdog.ts), so it is NOT type-checked and NOT linted. This suite is
// what stands in for that: it spawns the real string as a real worker and drives it
// over real HTTP. A syntax error, a bad metric name, or a broken wedge transition
// fails here and nowhere else.

type Harness = {
  worker: Worker;
  port: number;
  beat: BigInt64Array;
  scrape: (token?: string) => Promise<{ status: number; body: string }>;
};

const TOKEN = 'test-watchdog-token';
const THRESHOLD_MS = 300;

const harnesses: Harness[] = [];

async function startWorker(opts: { thresholdMs?: number; token?: string } = {}): Promise<Harness> {
  const sab = new SharedArrayBuffer(8);
  const beat = new BigInt64Array(sab);
  Atomics.store(beat, 0, BigInt(Date.now()));

  const worker = new Worker(WATCHDOG_WORKER_SOURCE, {
    eval: true,
    workerData: {
      sab,
      thresholdMs: opts.thresholdMs ?? THRESHOLD_MS,
      // Port 0 => the OS picks a free one and the worker reports it back, so
      // concurrent test files can never collide on a fixed port.
      port: 0,
      token: opts.token ?? TOKEN,
      heartbeatIntervalMs: 50,
      pollMs: 25,
    },
  });

  const port = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('worker never reported listening')), 10_000);
    worker.on('message', (msg: { type?: string; port?: number; message?: string }) => {
      if (msg?.type === 'listening' && msg.port) {
        clearTimeout(timeout);
        resolve(msg.port);
      } else if (msg?.type === 'error') {
        clearTimeout(timeout);
        reject(new Error(`worker reported error: ${msg.message}`));
      }
    });
    worker.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  const scrape = async (token: string | undefined = opts.token ?? TOKEN) => {
    const query = token === undefined ? '' : `?token=${encodeURIComponent(token)}`;
    const res = await fetch(`http://127.0.0.1:${port}/metrics${query}`);
    return { status: res.status, body: await res.text() };
  };

  const harness: Harness = { worker, port, beat, scrape };
  harnesses.push(harness);
  return harness;
}

/** Read a single unlabeled sample out of the Prometheus text exposition. */
function metric(body: string, name: string): number | undefined {
  const line = body.split('\n').find((l) => l.startsWith(`${name} `));
  return line === undefined ? undefined : Number(line.slice(name.length + 1));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.worker.terminate()));
});

describe('event-loop watchdog worker', () => {
  it('the source carries no backtick or ${ that would break out of its template', () => {
    // The source lives inside a String.raw template, so a single backtick anywhere in
    // it — including in a comment — silently TERMINATES the literal and turns the rest
    // into TypeScript. That happened once already: a comment reading /anything/metrics
    // in backticks broke the worker, prettier reformatted the wreckage, and every
    // spawn died with `ReferenceError: anything is not defined`. It is a whole class
    // of damage available to an innocuous comment edit, and it costs one assertion.
    expect(WATCHDOG_WORKER_SOURCE).not.toContain('`');
    expect(WATCHDOG_WORKER_SOURCE).not.toContain('${');
  });

  it('serves its metrics while the heartbeat is fresh', async () => {
    const h = await startWorker();
    h.beat.set([BigInt(Date.now())]);

    const { status, body } = await h.scrape();

    expect(status).toBe(200);
    expect(metric(body, 'civitai_app_watchdog_up')).toBe(1);
    expect(metric(body, 'civitai_app_watchdog_wedged')).toBe(0);
    expect(metric(body, 'civitai_app_watchdog_current_wedge_seconds')).toBe(0);
    expect(metric(body, 'civitai_app_watchdog_wedge_total')).toBe(0);
    expect(metric(body, 'civitai_app_watchdog_threshold_ms')).toBe(THRESHOLD_MS);
    expect(metric(body, 'civitai_app_watchdog_heartbeat_age_ms')).toBeLessThan(THRESHOLD_MS);
  });

  it('reports a wedge while the main thread is still stalled', async () => {
    const h = await startWorker();

    // Withholding beats is an ABSORBING state: nothing can end the wedge except this
    // test resuming the heartbeat, so there is no window to lose. Asserting the
    // wedge while it is still in progress is the whole point — the duration
    // histogram only observes on recovery, so a pod killed mid-wedge would never
    // report one.
    await sleep(THRESHOLD_MS * 3);

    const { body } = await h.scrape();

    expect(metric(body, 'civitai_app_watchdog_wedged')).toBe(1);
    expect(metric(body, 'civitai_app_watchdog_heartbeat_age_ms')).toBeGreaterThanOrEqual(
      THRESHOLD_MS
    );
    expect(metric(body, 'civitai_app_watchdog_current_wedge_seconds')).toBeGreaterThan(0);
    // Not yet recovered, so nothing has been observed into the histogram.
    expect(metric(body, 'civitai_app_watchdog_wedge_total')).toBe(0);
    expect(metric(body, 'civitai_app_watchdog_wedge_duration_seconds_count')).toBe(0);
  });

  it('closes out the wedge on recovery and dates it from the last beat', async () => {
    const h = await startWorker();

    const stalledFor = THRESHOLD_MS * 3;
    await sleep(stalledFor);
    h.beat.set([BigInt(Date.now())]);
    // One poll interval is enough for the worker to see the fresh beat.
    await sleep(150);

    const { body } = await h.scrape();

    expect(metric(body, 'civitai_app_watchdog_wedged')).toBe(0);
    expect(metric(body, 'civitai_app_watchdog_current_wedge_seconds')).toBe(0);
    expect(metric(body, 'civitai_app_watchdog_wedge_total')).toBe(1);
    expect(metric(body, 'civitai_app_watchdog_wedge_duration_seconds_count')).toBe(1);

    // Dated from the last beat, not from detection: the recorded duration must cover
    // the whole stall including the threshold, not just the part after we noticed.
    const observed = metric(body, 'civitai_app_watchdog_wedge_duration_seconds_sum') ?? 0;
    expect(observed).toBeGreaterThanOrEqual((stalledFor / 1000) * 0.9);
    expect(metric(body, 'civitai_app_watchdog_wedge_longest_seconds')).toBeCloseTo(observed, 5);

    // The +Inf bucket must equal _count, or histogram_quantile() silently misreads.
    const inf = Number(
      body
        .split('\n')
        .find((l) => l.startsWith('civitai_app_watchdog_wedge_duration_seconds_bucket{le="+Inf"}'))
        ?.split(' ')
        .pop()
    );
    expect(inf).toBe(1);
  });

  it('rejects a scrape with a wrong or missing token', async () => {
    const h = await startWorker();

    expect((await h.scrape('nope')).status).toBe(401);
    expect((await h.scrape('')).status).toBe(401);
    // Same length as the real token, to exercise the timing-safe compare rather
    // than the length short-circuit.
    expect((await h.scrape('x'.repeat(TOKEN.length))).status).toBe(401);
    expect((await h.scrape()).status).toBe(200);
  });

  it('FAILS CLOSED: refuses to listen at all when no token is configured', async () => {
    // The listener binds 0.0.0.0, so serving unauthenticated would make the port
    // cluster-readable and reduce containment to "it isn't on a Service" — a property
    // of the scrape config rather than of this code. Refusing is a visible failure
    // (worker_started=0); serving unauthenticated is an invisible one.
    const sab = new SharedArrayBuffer(8);
    Atomics.store(new BigInt64Array(sab), 0, BigInt(Date.now()));

    const worker = new Worker(WATCHDOG_WORKER_SOURCE, {
      eval: true,
      workerData: {
        sab,
        thresholdMs: 300,
        port: 0,
        token: '',
        heartbeatIntervalMs: 50,
        pollMs: 25,
      },
    });

    const messages: string[] = [];
    worker.on('message', (msg: { type?: string; message?: string }) => {
      if (msg?.type === 'error' && msg.message) messages.push(msg.message);
      // A 'listening' message here would mean it bound the port anyway.
      if (msg?.type === 'listening') messages.push('LISTENING');
    });

    const exitCode = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('worker never exited')), 10_000);
      worker.once('exit', (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
      worker.once('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    expect(exitCode).not.toBe(0);
    expect(messages).not.toContain('LISTENING');
    expect(messages.join(' ')).toContain('refusing to serve metrics');
  });

  it('404s anything that is not exactly GET /metrics', async () => {
    const h = await startWorker();

    expect((await fetch(`http://127.0.0.1:${h.port}/`)).status).toBe(404);
    // Not endsWith: a nested path must not serve.
    expect((await fetch(`http://127.0.0.1:${h.port}/anything/metrics?token=${TOKEN}`)).status).toBe(
      404
    );

    const wrongMethod = await fetch(`http://127.0.0.1:${h.port}/metrics?token=${TOKEN}`, {
      method: 'POST',
    });
    expect(wrongMethod.status).toBe(404);
  });

  it('exits on the shutdown message rather than being terminated', async () => {
    const h = await startWorker();

    const exitCode = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('worker did not exit on shutdown')), 8000);
      h.worker.once('exit', (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
      h.worker.postMessage({ type: 'shutdown' });
    });

    expect(exitCode).toBe(0);
  });
});
