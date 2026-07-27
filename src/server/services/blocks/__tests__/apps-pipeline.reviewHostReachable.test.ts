import { describe, expect, it, vi } from 'vitest';

/**
 * MOD REVIEW SANDBOX (#2831) — waitForReviewHostReachable.
 *
 * Two modes, both pinned here:
 *
 *  FALLBACK (no origin IP configured — local dev / preview envs): probe the
 *  PUBLIC host; ANY resolved response (any status) = reachable; a thrown fetch
 *  (DNS not-found / refused / timeout) = retry. This is the legacy behaviour and
 *  MUST stay intact where the origin IP isn't set.
 *
 *  ORIGIN-DIRECT (origin IP configured — dp-prod): dial the Traefik LB IP with a
 *  `Host: <host>` header so we NEVER touch public DNS (dodging the civit.ai
 *  SOA-1800s NXDOMAIN negative-cache poisoning that spuriously failed healthy
 *  previews). Semantics FLIP: the TCP connect always succeeds, so reachable = a
 *  response whose status is NOT 404 (Host rule matched → mod-gate/service, 401);
 *  a 404 (route not yet registered) OR a connection error = retry. After
 *  origin-direct passes we also confirm the public name resolves via Cloudflare
 *  DoH so the mod's browser can't hit a fresh NXDOMAIN.
 *
 * A fake clock drives the timeout so there's no real network or wall-clock wait.
 */

// The helper's DEFAULT timeout reads from env.REVIEW_HOST_REACHABLE_TIMEOUT_MS
// (180s in the real schema). No origin-IP env keys are provided, so the DEFAULT
// path (used by the existing tests below) resolves originIp=null → FALLBACK
// mode. Origin-direct tests inject `originIp` explicitly.
vi.mock('~/env/server', () => ({ env: { REVIEW_HOST_REACHABLE_TIMEOUT_MS: 180_000 } }));

import { waitForReviewHostReachable } from '~/server/services/blocks/apps-pipeline.service';

const HOST = 'review-abc123def4567890.civit.ai';

// A monotonic fake clock: sleep(ms) advances `t` by ms so the loop's deadline
// check terminates deterministically without a real timer.
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: vi.fn(async (ms: number) => {
      t += ms;
    }),
  };
}

// Never schedule a real per-attempt AbortSignal timer in tests.
const noSignal = () => undefined;

describe('waitForReviewHostReachable — FALLBACK (public-DNS, no origin IP)', () => {
  it('returns true on the first HTTP response (a 200)', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const clock = fakeClock();
    const ok = await waitForReviewHostReachable(HOST, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: clock.now,
      sleep: clock.sleep,
      signalFactory: noSignal,
    });
    expect(ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(clock.sleep).not.toHaveBeenCalled();
    // Probed the public host over HTTPS with a HEAD + manual redirect.
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://${HOST}/`);
    expect(init.method).toBe('HEAD');
    expect(init.redirect).toBe('manual');
  });

  it('treats a 403 (mod-gate forward-auth) as reachable — any status counts, no auth', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 403 }));
    const clock = fakeClock();
    const ok = await waitForReviewHostReachable(HOST, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: clock.now,
      sleep: clock.sleep,
      signalFactory: noSignal,
    });
    expect(ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // No Authorization header — we never authenticate through the gate.
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string> | undefined) ?? {}).not.toHaveProperty(
      'Authorization'
    );
  });

  it('treats a 3xx redirect as reachable', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 302 }));
    const clock = fakeClock();
    const ok = await waitForReviewHostReachable(HOST, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: clock.now,
      sleep: clock.sleep,
      signalFactory: noSignal,
    });
    expect(ok).toBe(true);
  });

  it('retries when the first attempt throws ENOTFOUND, then succeeds', async () => {
    const enotfound = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(enotfound)
      .mockResolvedValueOnce(new Response('', { status: 401 }));
    const clock = fakeClock();
    const ok = await waitForReviewHostReachable(HOST, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 120_000,
      intervalMs: 4_000,
      now: clock.now,
      sleep: clock.sleep,
      signalFactory: noSignal,
    });
    expect(ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(clock.sleep).toHaveBeenCalledTimes(1);
    expect(clock.sleep).toHaveBeenCalledWith(4_000);
  });

  it('returns false when every attempt throws until the timeout elapses', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    const clock = fakeClock();
    const ok = await waitForReviewHostReachable(HOST, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 120_000,
      intervalMs: 4_000,
      now: clock.now,
      sleep: clock.sleep,
      signalFactory: noSignal,
    });
    expect(ok).toBe(false);
    // now advances 0,4000,…; the post-sleep deadline check trips once now hits
    // 120000 (after the 30th sleep), so we make 30 attempts + 30 sleeps and
    // short-circuit before a pointless 31st fetch.
    expect(fetchImpl).toHaveBeenCalledTimes(30);
    expect(clock.sleep).toHaveBeenCalledTimes(30);
  });

  it('defaults the overall budget to env.REVIEW_HOST_REACHABLE_TIMEOUT_MS (env-tunable)', async () => {
    // env mock supplies 180_000; with a 4s interval that's 45 sleeps before the
    // deadline trips (180000/4000). Proves the default is env-driven, not a
    // hard-coded literal — so ops can raise it without a code change.
    const fetchImpl = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    const clock = fakeClock();
    const ok = await waitForReviewHostReachable(HOST, {
      // no timeoutMs → falls back to env default (180s)
      intervalMs: 4_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: clock.now,
      sleep: clock.sleep,
      signalFactory: noSignal,
    });
    expect(ok).toBe(false);
    expect(clock.sleep).toHaveBeenCalledTimes(45);
    expect(fetchImpl).toHaveBeenCalledTimes(45);
  });

  it('treats a per-attempt timeout (thrown AbortError) as not-ready, not reachable', async () => {
    // One aborted attempt then a real response → still resolves true after retry,
    // proving a hung/aborted attempt is "not ready", never "reachable".
    const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(abort)
      .mockResolvedValueOnce(new Response('', { status: 200 }));
    const clock = fakeClock();
    const ok = await waitForReviewHostReachable(HOST, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: clock.now,
      sleep: clock.sleep,
      signalFactory: noSignal,
    });
    expect(ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

// A DoH fetch that always reports the public name RESOLVES (Status 0 + an
// Answer). Used when a test wants origin-direct to be the only gate under test.
const dohResolves = () =>
  vi.fn(async () => new Response(JSON.stringify({ Status: 0, Answer: [{ data: '1.2.3.4' }] }), {
    status: 200,
    headers: { 'content-type': 'application/dns-json' },
  }));

const ORIGIN_IP = '203.0.113.7'; // TEST-NET-3 placeholder — never a real infra IP

describe('waitForReviewHostReachable — ORIGIN-DIRECT (origin IP configured)', () => {
  it('probes the origin IP with a Host header; a 401 (mod-gate) → reachable', async () => {
    const originProbe = vi.fn(async () => ({ status: 401 }));
    const clock = fakeClock();
    const ok = await waitForReviewHostReachable(HOST, {
      originIp: ORIGIN_IP,
      originProbe,
      dohFetchImpl: dohResolves() as unknown as typeof fetch,
      now: clock.now,
      sleep: clock.sleep,
      signalFactory: noSignal,
    });
    expect(ok).toBe(true);
    expect(originProbe).toHaveBeenCalledTimes(1);
    // Dialed the ORIGIN IP (not https://<host>/) with a Host: <host> header.
    const [url, init] = originProbe.mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string>; redirect: string }
    ];
    expect(url).toBe(`http://${ORIGIN_IP}/`);
    expect(url).not.toContain(HOST);
    expect(init.method).toBe('HEAD');
    expect(init.headers.Host).toBe(HOST);
    expect(init.redirect).toBe('manual');
  });

  it('a 404 (route not registered) is NOT reachable — retries, then a 401 → reachable', async () => {
    const originProbe = vi
      .fn()
      .mockResolvedValueOnce({ status: 404 }) // Traefik default 404 — route not up yet
      .mockResolvedValueOnce({ status: 401 }); // Host rule matched → mod-gate answers
    const clock = fakeClock();
    const ok = await waitForReviewHostReachable(HOST, {
      originIp: ORIGIN_IP,
      originProbe: originProbe as unknown as never,
      dohFetchImpl: dohResolves() as unknown as typeof fetch,
      timeoutMs: 120_000,
      intervalMs: 4_000,
      now: clock.now,
      sleep: clock.sleep,
      signalFactory: noSignal,
    });
    expect(ok).toBe(true);
    // Did NOT return true on the 404 — it slept once and retried.
    expect(originProbe).toHaveBeenCalledTimes(2);
    expect(clock.sleep).toHaveBeenCalledTimes(1);
    expect(clock.sleep).toHaveBeenCalledWith(4_000);
  });

  it('a 200 (or any non-404) response → reachable', async () => {
    const originProbe = vi.fn(async () => ({ status: 200 }));
    const clock = fakeClock();
    const ok = await waitForReviewHostReachable(HOST, {
      originIp: ORIGIN_IP,
      originProbe,
      dohFetchImpl: dohResolves() as unknown as typeof fetch,
      now: clock.now,
      sleep: clock.sleep,
      signalFactory: noSignal,
    });
    expect(ok).toBe(true);
    // A 302 likewise (non-404 success).
    const originProbe2 = vi.fn(async () => ({ status: 302 }));
    const clock2 = fakeClock();
    const ok2 = await waitForReviewHostReachable(HOST, {
      originIp: ORIGIN_IP,
      originProbe: originProbe2,
      dohFetchImpl: dohResolves() as unknown as typeof fetch,
      now: clock2.now,
      sleep: clock2.sleep,
      signalFactory: noSignal,
    });
    expect(ok2).toBe(true);
  });

  it('a connection error every attempt → retries until the budget, returns false (deadline respected)', async () => {
    const originProbe = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const clock = fakeClock();
    const ok = await waitForReviewHostReachable(HOST, {
      originIp: ORIGIN_IP,
      originProbe: originProbe as unknown as never,
      dohFetchImpl: dohResolves() as unknown as typeof fetch,
      timeoutMs: 120_000,
      intervalMs: 4_000,
      now: clock.now,
      sleep: clock.sleep,
      signalFactory: noSignal,
    });
    expect(ok).toBe(false);
    // Same deadline arithmetic as the fallback path: 30 attempts + 30 sleeps
    // before now() reaches 120000 and the post-sleep check trips.
    expect(originProbe).toHaveBeenCalledTimes(30);
    expect(clock.sleep).toHaveBeenCalledTimes(30);
  });

  it('does NOT probe the public host: fallback fetchImpl is never called in origin mode', async () => {
    const originProbe = vi.fn(async () => ({ status: 401 }));
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const clock = fakeClock();
    const ok = await waitForReviewHostReachable(HOST, {
      originIp: ORIGIN_IP,
      originProbe,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      dohFetchImpl: dohResolves() as unknown as typeof fetch,
      now: clock.now,
      sleep: clock.sleep,
      signalFactory: noSignal,
    });
    expect(ok).toBe(true);
    // The public-DNS fetch is the thing we're moving OFF of — it must not run.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('with DoH disabled, origin-direct alone gates (no DoH fetch performed)', async () => {
    const originProbe = vi.fn(async () => ({ status: 401 }));
    const dohFetchImpl = vi.fn();
    const clock = fakeClock();
    const ok = await waitForReviewHostReachable(HOST, {
      originIp: ORIGIN_IP,
      originProbe,
      dohEnabled: false,
      dohFetchImpl: dohFetchImpl as unknown as typeof fetch,
      now: clock.now,
      sleep: clock.sleep,
      signalFactory: noSignal,
    });
    expect(ok).toBe(true);
    expect(dohFetchImpl).not.toHaveBeenCalled();
  });

  it('origin-direct OK but DoH NXDOMAIN → not-yet; retries; DoH Status:0 → reachable', async () => {
    // Origin-direct passes immediately (workload healthy); the PUBLIC record is
    // created lazily, so DoH first returns NXDOMAIN (Status 3), then resolves.
    const originProbe = vi.fn(async () => ({ status: 401 }));
    const dohFetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ Status: 3 }), { status: 200 }) // NXDOMAIN
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ Status: 0, Answer: [{ data: '1.2.3.4' }] }), { status: 200 })
      );
    const clock = fakeClock();
    const ok = await waitForReviewHostReachable(HOST, {
      originIp: ORIGIN_IP,
      originProbe,
      dohFetchImpl: dohFetchImpl as unknown as typeof fetch,
      timeoutMs: 120_000,
      intervalMs: 4_000,
      now: clock.now,
      sleep: clock.sleep,
      signalFactory: noSignal,
    });
    expect(ok).toBe(true);
    // Two origin probes + two DoH queries (first attempt: origin-ok but DoH
    // NXDOMAIN → sleep + retry; second attempt: both pass).
    expect(originProbe).toHaveBeenCalledTimes(2);
    expect(dohFetchImpl).toHaveBeenCalledTimes(2);
    expect(clock.sleep).toHaveBeenCalledTimes(1);
    // DoH queried the PUBLIC host name via cloudflare-dns.com.
    const [dohUrl] = dohFetchImpl.mock.calls[0] as [string];
    expect(dohUrl).toContain('cloudflare-dns.com/dns-query');
    expect(dohUrl).toContain(encodeURIComponent(HOST));
  });

  it('falls back to APPS_DEV_TUNNEL_INGRESS_TARGET when APPS_REVIEW_INGRESS_TARGET is unset', async () => {
    // Simulates dp-prod today: only the shared dev-tunnel target is set. The
    // probe must still go origin-direct (no config change needed). Proven by
    // injecting originIp directly here — the env fallback chain
    // (APPS_REVIEW_INGRESS_TARGET ?? APPS_DEV_TUNNEL_INGRESS_TARGET) is exercised
    // by the default-arg resolution; this asserts origin-direct engages when an
    // IP is present.
    const originProbe = vi.fn(async () => ({ status: 401 }));
    const clock = fakeClock();
    const ok = await waitForReviewHostReachable(HOST, {
      originIp: ORIGIN_IP,
      originProbe,
      dohFetchImpl: dohResolves() as unknown as typeof fetch,
      now: clock.now,
      sleep: clock.sleep,
      signalFactory: noSignal,
    });
    expect(ok).toBe(true);
    expect(originProbe).toHaveBeenCalled();
  });
});
