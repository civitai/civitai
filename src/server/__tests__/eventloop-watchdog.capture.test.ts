import { Worker } from 'node:worker_threads';
import nodeCrypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WATCHDOG_WORKER_SOURCE, resolveCaptureConfig } from '~/server/eventloop-watchdog';

// The capture half of the worker. Like the detector suite, this drives the REAL
// inlined source rather than a TypeScript stand-in, because the source is neither
// type-checked nor linted and that is the only way it gets exercised.

const ENV_KEYS = [
  'EVENTLOOP_WATCHDOG_CAPTURE_ENABLED',
  'EVENTLOOP_WATCHDOG_CAPTURE_MS',
  'EVENTLOOP_WATCHDOG_CAPTURE_INTERVAL_US',
  'EVENTLOOP_WATCHDOG_CAPTURE_MAX_PER_HOUR',
  'CPU_PROFILE_S3_KEY_PREFIX',
] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  vi.resetModules();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('capture config', () => {
  it('is disarmed unless explicitly enabled, independently of the detector', async () => {
    // Detection is cheap and safe everywhere; capture opens an inspector, drives CDP
    // and uploads. They must be separate gates or enabling the watchdog silently
    // enables the expensive half.
    const { resolveCaptureConfig: resolve } = await import('~/server/eventloop-watchdog');
    expect(resolve().enabled).toBe(false);

    process.env.EVENTLOOP_WATCHDOG_CAPTURE_ENABLED = 'true';
    expect((await import('~/server/eventloop-watchdog')).resolveCaptureConfig().enabled).toBe(true);
  });

  it('clamps duration and sampling interval rather than trusting them', () => {
    process.env.EVENTLOOP_WATCHDOG_CAPTURE_MS = '999999';
    expect(resolveCaptureConfig().captureMs).toBe(30_000);
    process.env.EVENTLOOP_WATCHDOG_CAPTURE_MS = '1';
    expect(resolveCaptureConfig().captureMs).toBe(1000);

    // 100Hz default. The old in-process path sampled at 1kHz and produced 41-46MB
    // profiles on SSR, which is why the default is not the V8 default.
    delete process.env.EVENTLOOP_WATCHDOG_CAPTURE_INTERVAL_US;
    expect(resolveCaptureConfig().samplingIntervalUs).toBe(10_000);
  });

  it('defaults the key prefix and carries pool/pod/imageTag for the object key', () => {
    const cfg = resolveCaptureConfig();
    expect(cfg.keyPrefix).toBe('cpu-profiles/');
    expect(cfg).toMatchObject({
      pool: expect.any(String),
      pod: expect.any(String),
      imageTag: expect.any(String),
    });
  });
});

/**
 * Pull the signer out of the inlined worker source and evaluate it in isolation.
 * Sliced between markers rather than duplicated, so the test cannot drift from the
 * code it checks — if the markers move the slice fails loudly instead of testing a
 * stale copy.
 */
function loadSigner() {
  const from = WATCHDOG_WORKER_SOURCE.indexOf('function hmac(');
  const to = WATCHDOG_WORKER_SOURCE.indexOf('function putObject(');
  expect(from, 'signer start marker not found in worker source').toBeGreaterThan(-1);
  expect(to, 'signer end marker not found in worker source').toBeGreaterThan(from);
  const src = WATCHDOG_WORKER_SOURCE.slice(from, to);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function('crypto', `${src}; return signPut;`)(nodeCrypto) as (opts: {
    now: Date;
    host: string;
    path: string;
    region: string;
    accessKeyId: string;
    secretKey: string;
    body: Buffer;
  }) => { amzDate: string; payloadHash: string; authorization: string };
}

describe('SigV4 signer', () => {
  const base = {
    now: new Date('2013-05-24T00:00:00Z'),
    host: 'examplebucket.s3.amazonaws.com',
    path: '/examplebucket/test.txt',
    region: 'us-east-1',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    body: Buffer.from('Welcome to Amazon S3.'),
  };

  it('produces the documented AWS wire format', () => {
    const signPut = loadSigner();
    const { amzDate, payloadHash, authorization } = signPut(base);

    expect(amzDate).toBe('20130524T000000Z');
    // sha256 of the body, which AWS's own PUT example publishes.
    expect(payloadHash).toBe('44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
    expect(authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/
    );
  });

  it('is deterministic, and every input actually participates', () => {
    // A signer that ignores an input is the failure that looks fine until the server
    // rejects it — and the rejection is a 403 with no detail.
    const signPut = loadSigner();
    const sig = (o: Partial<typeof base>) =>
      signPut({ ...base, ...o }).authorization.split('Signature=')[1];

    expect(sig({})).toBe(sig({}));
    for (const [label, mutation] of [
      ['secret', { secretKey: base.secretKey + 'x' }],
      ['region', { region: 'eu-west-1' }],
      ['path', { path: '/examplebucket/other.txt' }],
      ['host', { host: 'other.example.com' }],
      ['body', { body: Buffer.from('different') }],
      ['date', { now: new Date('2013-05-25T00:00:00Z') }],
    ] as const) {
      expect(sig(mutation), `${label} does not affect the signature`).not.toBe(sig({}));
    }
  });
});

describe('starvation classifier', () => {
  // The dominant wedge class on this fleet is the main thread being descheduled, not
  // looping — sliced production captures showed no JS executing during the wedge,
  // against 2.28s/s of runqueue wait. A profiler cannot see that. CPU-time against
  // wall-time can, and this proves the two classes actually separate rather than that
  // the code runs.

  async function runWedge(kind: 'starved' | 'executing') {
    const sab = new SharedArrayBuffer(8);
    const beat = new BigInt64Array(sab);
    Atomics.store(beat, 0, BigInt(Date.now()));

    const worker = new Worker(WATCHDOG_WORKER_SOURCE, {
      eval: true,
      workerData: {
        sab,
        thresholdMs: 300,
        port: 0,
        token: 'classifier-test',
        heartbeatIntervalMs: 50,
        pollMs: 25,
        cap: { ...resolveCaptureConfig(), enabled: false },
        s3: {},
        starvedRatio: 0.2,
      },
    });

    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('never listened')), 10_000);
      worker.on('message', (m: { type?: string; port?: number }) => {
        if (m?.type === 'listening' && m.port) {
          clearTimeout(timer);
          resolve(m.port);
        }
      });
      worker.on('error', reject);
    });

    // Withhold beats for 1.5s. In the executing case the MAIN thread burns CPU
    // throughout, which is what the classifier has to notice; in the starved case it
    // does nothing, standing in for a descheduled thread.
    const until = Date.now() + 1500;
    if (kind === 'executing') {
      let sink = 0;
      while (Date.now() < until) sink += Math.sqrt(Math.random());
      void sink;
    } else {
      await new Promise((r) => setTimeout(r, 1500));
    }

    Atomics.store(beat, 0, BigInt(Date.now()));
    await new Promise((r) => setTimeout(r, 250));

    const body = await (
      await fetch(`http://127.0.0.1:${port}/metrics?token=classifier-test`)
    ).text();
    await worker.terminate();
    return body;
  }

  const read = (body: string, name: string) =>
    Number(
      body
        .split('\n')
        .find((l) => l.startsWith(`${name} `))
        ?.slice(name.length + 1)
    );

  it('🔴 classifies a CPU-burning wedge as executing', async () => {
    const body = await runWedge('executing');
    expect(read(body, 'civitai_app_watchdog_wedge_kind_total{kind="executing"}')).toBe(1);
    expect(read(body, 'civitai_app_watchdog_wedge_kind_total{kind="starved"}')).toBe(0);
  }, 30_000);

  it('🔴 classifies an idle wedge as starved, and skips the capture', async () => {
    const body = await runWedge('starved');
    expect(read(body, 'civitai_app_watchdog_wedge_kind_total{kind="starved"}')).toBe(1);
    expect(read(body, 'civitai_app_watchdog_wedge_kind_total{kind="executing"}')).toBe(0);
    // The whole point of the gate: a starved wedge has nothing to sample, so no
    // profile is taken and no idle artefact reaches the corpus.
    expect(read(body, 'civitai_app_watchdog_capture_total{result="skipped-starved"}')).toBe(1);
  }, 30_000);

  it('exposes the ratio distribution and the threshold echo', async () => {
    // A gauge of the last value could not answer "where do starved wedges actually
    // sit" — the continuous profiler adds a CPU floor, so that has to be readable
    // rather than assumed.
    const body = await runWedge('starved');
    expect(body).toContain('civitai_app_watchdog_wedge_cpu_ratio_bucket{le="0.05"}');
    expect(body).toContain('civitai_app_watchdog_wedge_cpu_ratio_count 1');
    expect(read(body, 'civitai_app_watchdog_starved_ratio_threshold')).toBe(0.2);
  }, 30_000);
});

describe('capture metrics', () => {
  it('exposes every capture series even before anything is captured', async () => {
    // Absent and zero mean different things to an alert. A pool with capture armed
    // and nothing yet captured must read 0, not no-series.
    const sab = new SharedArrayBuffer(8);
    Atomics.store(new BigInt64Array(sab), 0, BigInt(Date.now()));

    const worker = new Worker(WATCHDOG_WORKER_SOURCE, {
      eval: true,
      workerData: {
        sab,
        thresholdMs: 1000,
        port: 0,
        // Non-empty: the worker fails closed and exits 78 without a token, so an empty
        // one here would never reach the metrics path at all.
        token: 'capture-test-token',
        heartbeatIntervalMs: 100,
        pollMs: 50,
        cap: { ...resolveCaptureConfig(), enabled: false },
        s3: {},
      },
    });

    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('never listened')), 10_000);
      worker.on('message', (m: { type?: string; port?: number }) => {
        if (m?.type === 'listening' && m.port) {
          clearTimeout(timer);
          resolve(m.port);
        }
      });
      worker.on('error', reject);
    });

    const body = await (
      await fetch(`http://127.0.0.1:${port}/metrics?token=capture-test-token`)
    ).text();
    await worker.terminate();

    for (const series of [
      'civitai_app_watchdog_capture_total{result="ok"} 0',
      'civitai_app_watchdog_capture_total{result="error"} 0',
      'civitai_app_watchdog_capture_total{result="skipped-backoff"} 0',
      'civitai_app_watchdog_capture_total{result="skipped-hourly-cap"} 0',
      'civitai_app_watchdog_upload_total{result="ok"} 0',
      'civitai_app_watchdog_upload_bytes_total 0',
      'civitai_app_watchdog_last_capture_timestamp_seconds 0',
    ]) {
      expect(body, series).toContain(series);
    }
  });
});
