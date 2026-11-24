import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { gunzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import Pyroscope from '@pyroscope/nodejs';
import { time } from '@datadog/pprof';
import {
  __resetProfileRouteLabelsForTests,
  type PprofTime,
  startWallProfilingWithAsyncContext,
  withProfileRoute,
} from '~/server/pyroscope-labels';

// The SEAM test: the real @pyroscope/nodejs SDK, the real native @datadog/pprof profiler, and
// this app's arming + wrapper — each of which is unit-tested alone, but only together do they
// put a `route` label on a sample. The SDK pushes its profile to a local HTTP sink, and the test
// reads the label out of what it pushed.
//
// The labelled CPU burn runs only AFTER an `await`, so a label found on it proves the context
// followed the continuation (the SDK's own synchronous `wrapWithLabels` would leave it
// unlabelled). A pprof string table holds only strings some sample or location uses, so a label
// value appears in the pushed bytes only if a sample carried it.

const LABELLED_ROUTE = 'trpc:profilerSeam.afterAwait';
const NEVER_USED_ROUTE = 'trpc:profilerSeam.neverRun';

function burnCpu(ms: number) {
  const end = performance.now() + ms;
  let x = 0;
  while (performance.now() < end) x += Math.sqrt(x + 1);
  return x;
}

const pushes: Buffer[] = [];
const sink = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    pushes.push(Buffer.concat(chunks));
    res.end();
  });
});

afterAll(async () => {
  __resetProfileRouteLabelsForTests();
  await new Promise((resolve) => sink.close(resolve));
});

function decode(body: Buffer): string {
  try {
    return gunzipSync(body).toString('latin1');
  } catch {
    return body.toString('latin1');
  }
}

describe('pyroscope route labels on a real profile', () => {
  it('labels CPU samples taken after an await with the route, and nothing else', async () => {
    await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve));
    const { port } = sink.address() as AddressInfo;

    Pyroscope.init({
      serverAddress: `http://127.0.0.1:${port}`,
      appName: 'profiler-seam-test',
      // Never flush on a timer during the test; stopWallProfiling() pushes the one profile.
      flushIntervalMs: 10 * 60_000,
      wall: { collectCpuTime: true, samplingIntervalMicros: 1_000 },
    });
    const armed = startWallProfilingWithAsyncContext(
      () => Pyroscope.startWallProfiling(),
      time as unknown as PprofTime
    );
    expect(armed, 'route labels did not arm against the real SDK + pprof').toBe(true);

    await withProfileRoute(LABELLED_ROUTE, async () => {
      await sleep(5);
      burnCpu(400);
    });
    burnCpu(100); // unlabelled control work

    await Pyroscope.stopWallProfiling();

    expect(pushes.length, 'the SDK pushed nothing to the sink').toBeGreaterThan(0);
    const profile = pushes.map(decode).join('\n');
    // Positive control: the pushed bytes are a profile this test can read (the burn's own
    // function name is in its string table).
    expect(profile).toContain('burnCpu');
    expect(profile).toContain(LABELLED_ROUTE);
    // Negative control: a route no code ran under is absent, so a match above is not an
    // artifact of how the bytes are read.
    expect(profile).not.toContain(NEVER_USED_ROUTE);
  }, 30_000);
});
