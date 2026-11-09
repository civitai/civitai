import { describe, expect, it, vi } from 'vitest';
import { envMock } from '~/__tests__/mocks/env.mock';
import {
  SHARED_REVIEW_PROBE_HEADERS,
  waitForReviewHostReachable,
  type OriginProbe,
} from '~/server/services/blocks/apps-pipeline.service';

/**
 * Reachability of a review preview published to the SHARED static server
 * (`app-blocks-review-shared-server`). The shared review route always exists and is mod-gated: a
 * request without `Sec-Fetch-Dest` is an ENTRY request and is denied (never 404), so the per-preview
 * rule "reachable = not 404" would be true before anything was published. The probe is a
 * non-entry GET that must answer 200.
 */

const HOST = 'review-abc123def4567890.civit.ai';
const noSignal = () => undefined;

function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: vi.fn(async (ms: number) => {
      t += ms;
    }),
  };
}

function probeAnswering(statuses: number[]) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const probe: OriginProbe = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers });
    return { status: statuses[Math.min(calls.length - 1, statuses.length - 1)] };
  };
  return { probe, calls };
}

describe('waitForReviewHostReachable — shared static server', () => {
  it('probes the origin with a non-entry GET for the review host, and a 200 is reachable', async () => {
    const { probe, calls } = probeAnswering([200]);
    const clock = fakeClock();
    const ok = await waitForReviewHostReachable(HOST, {
      sharedServer: true,
      originIp: '192.0.2.10',
      originProbe: probe,
      now: clock.now,
      sleep: clock.sleep,
      signalFactory: noSignal,
    });
    expect(ok).toBe(true);
    expect(calls).toEqual([
      {
        url: 'http://192.0.2.10/',
        method: 'GET',
        headers: { Host: HOST, 'Sec-Fetch-Dest': 'empty' },
      },
    ]);
    expect(SHARED_REVIEW_PROBE_HEADERS).toEqual({ 'Sec-Fetch-Dest': 'empty' });
  });

  it('a 401 (the gate refusing an entry request) and a 404 (meta not read yet) are NOT reachable', async () => {
    const { probe, calls } = probeAnswering([401, 404, 404, 200]);
    const clock = fakeClock();
    const ok = await waitForReviewHostReachable(HOST, {
      sharedServer: true,
      originIp: '192.0.2.10',
      originProbe: probe,
      now: clock.now,
      sleep: clock.sleep,
      signalFactory: noSignal,
    });
    expect(ok).toBe(true);
    expect(calls).toHaveLength(4);
    // Retries every second.
    expect(clock.sleep.mock.calls.map((c) => c[0])).toEqual([1000, 1000, 1000]);
  });

  it('gives up after 15s of 404s', async () => {
    const { probe, calls } = probeAnswering([404]);
    const clock = fakeClock();
    const ok = await waitForReviewHostReachable(HOST, {
      sharedServer: true,
      originIp: '192.0.2.10',
      originProbe: probe,
      now: clock.now,
      sleep: clock.sleep,
      signalFactory: noSignal,
    });
    expect(ok).toBe(false);
    expect(calls.length).toBeGreaterThanOrEqual(15);
    expect(calls.length).toBeLessThanOrEqual(17);
  });

  it('CONTROL: the per-preview probe (flag off) still counts a 401 as reachable', async () => {
    const { probe, calls } = probeAnswering([401]);
    const clock = fakeClock();
    envMock.set({ REVIEW_HOST_REACHABLE_TIMEOUT_MS: 180_000 });
    const ok = await waitForReviewHostReachable(HOST, {
      originIp: '192.0.2.10',
      originProbe: probe,
      now: clock.now,
      sleep: clock.sleep,
      signalFactory: noSignal,
    });
    expect(ok).toBe(true);
    expect(calls[0].method).toBe('HEAD');
  });

  it('without an origin IP, probes the public host with the same non-entry GET', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const clock = fakeClock();
    const ok = await waitForReviewHostReachable(HOST, {
      sharedServer: true,
      originIp: '',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: clock.now,
      sleep: clock.sleep,
      signalFactory: noSignal,
    });
    expect(ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://${HOST}/`);
    expect(init.method).toBe('GET');
    expect(init.headers).toEqual({ 'Sec-Fetch-Dest': 'empty' });
  });
});
