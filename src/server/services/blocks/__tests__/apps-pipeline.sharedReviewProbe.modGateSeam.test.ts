import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  waitForReviewHostReachable,
  type OriginProbe,
} from '~/server/services/blocks/apps-pipeline.service';
import { verifyReviewAccessToken } from '~/server/services/blocks/review-session';

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: unknown) => h }));

import modGateHandler from '~/pages/api/internal/mod-gate';

/**
 * SEAM: the shared-server review reachability probe (`waitForReviewHostReachable` with
 * `sharedServer: true`) against the REAL review forwardAuth gate (`/api/internal/mod-gate`).
 *
 * Each side is tested alone elsewhere; these cases feed the probe's actual request into the gate.
 * The probe's request is turned into the forwardAuth subrequest
 * Traefik would make (X-Forwarded-Host = the request Host, X-Forwarded-Uri = the request target
 * path+query, Sec-Fetch-Dest passed through) and handed to the real gate handler with a real secret.
 * Only when the gate admits it does the stand-in static server answer, with 200 for a published
 * review build. No part of the gate or the token code is mocked.
 */

const SECRET = 'test-nextauth-secret-seam-cccccccccccccccc';
const HOST = 'review-0123456789abcdef.civit.ai';
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

type GateVerdict = { status: number; modId?: string; via?: string; reason?: string };

/** Run the REAL mod-gate handler on the forwardAuth subrequest Traefik derives from a request. */
async function runGate(req: {
  host: string | undefined;
  target: string;
  secFetchDest: string | undefined;
}): Promise<GateVerdict> {
  const headers: Record<string, string> = { 'x-forwarded-uri': req.target };
  if (req.host !== undefined) headers['x-forwarded-host'] = req.host;
  if (req.secFetchDest !== undefined) headers['sec-fetch-dest'] = req.secFetchDest;
  const out: Record<string, string> = {};
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    setHeader(k: string, v: string) {
      out[k.toLowerCase()] = v;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  await modGateHandler(
    { method: 'GET', headers } as unknown as NextApiRequest,
    res as unknown as NextApiResponse
  );
  return {
    status: res.statusCode,
    modId: out['x-mod-id'],
    via: (res.body as { via?: string } | undefined)?.via,
    reason: out['x-mod-gate-reason'],
  };
}

describe('SEAM: shared-server review probe → real mod-gate', () => {
  const prevSecret = process.env.NEXTAUTH_SECRET;
  let server: http.Server | undefined;

  beforeEach(() => {
    process.env.NEXTAUTH_SECRET = SECRET;
  });
  afterEach(async () => {
    if (prevSecret === undefined) delete process.env.NEXTAUTH_SECRET;
    else process.env.NEXTAUTH_SECRET = prevSecret;
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  /**
   * A loopback stand-in for Traefik + the shared static server. `rewriteHost` lets the negative
   * control present a different host to the gate than the one the probe dialled.
   */
  async function startEdge(opts: { published: boolean; rewriteHost?: string }) {
    const verdicts: GateVerdict[] = [];
    const targets: string[] = [];
    server = http.createServer(async (req, res) => {
      targets.push(req.url ?? '');
      const dest = req.headers['sec-fetch-dest'];
      const verdict = await runGate({
        host: opts.rewriteHost ?? req.headers.host,
        target: req.url ?? '',
        secFetchDest: Array.isArray(dest) ? dest[0] : dest,
      });
      verdicts.push(verdict);
      if (verdict.status !== 200) {
        res.writeHead(verdict.status);
        res.end();
        return;
      }
      // Gate admitted it → the static server answers: the shell for a published build, 404 if its
      // meta is not there yet.
      res.writeHead(opts.published ? 200 : 404, { 'content-type': 'text/html' });
      res.end(opts.published ? '<!doctype html><div id="root"></div>' : '');
    });
    const port = await new Promise<number>((resolve) => {
      server!.listen(0, '127.0.0.1', () => resolve((server!.address() as AddressInfo).port));
    });
    return { port, verdicts, targets };
  }

  it('origin-direct (REAL defaultOriginProbe): the gate admits the probe and a published build is reachable', async () => {
    const edge = await startEdge({ published: true });
    const clock = fakeClock();
    const ok = await waitForReviewHostReachable(HOST, {
      sharedServer: true,
      originIp: `127.0.0.1:${edge.port}`,
      now: clock.now,
      sleep: clock.sleep,
      signalFactory: noSignal,
    });
    expect(edge.verdicts[0]).toMatchObject({ status: 200, via: 'token' });
    expect(ok).toBe(true);
    expect(edge.verdicts).toHaveLength(1);
    // The token rode the request target to the gate (the query string is not dropped).
    expect(edge.targets[0]).toMatch(/^\/\?mr=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it('origin-direct: an admitted probe on an UNPUBLISHED build (static 404) is not reachable', async () => {
    const edge = await startEdge({ published: false });
    const clock = fakeClock();
    const ok = await waitForReviewHostReachable(HOST, {
      sharedServer: true,
      originIp: `127.0.0.1:${edge.port}`,
      now: clock.now,
      sleep: clock.sleep,
      signalFactory: noSignal,
    });
    expect(ok).toBe(false);
    // Positive control: the gate DID admit every attempt, so the false is the 404, not the gate.
    expect(edge.verdicts.length).toBeGreaterThan(1);
    expect(edge.verdicts.every((v) => v.status === 200 && v.via === 'token')).toBe(true);
  });

  it('NEGATIVE CONTROL: a token bound to the probed host is refused for a different host', async () => {
    const edge = await startEdge({
      published: true,
      rewriteHost: 'review-ffffffffffffffff.civit.ai',
    });
    const clock = fakeClock();
    const ok = await waitForReviewHostReachable(HOST, {
      sharedServer: true,
      originIp: `127.0.0.1:${edge.port}`,
      now: clock.now,
      sleep: clock.sleep,
      signalFactory: noSignal,
    });
    expect(ok).toBe(false);
    expect(edge.verdicts.length).toBeGreaterThan(1);
    expect(edge.verdicts.every((v) => v.status === 401)).toBe(true);
  });

  it('public-host fetch branch (no origin IP): the gate admits the probe and a published build is reachable', async () => {
    const verdicts: GateVerdict[] = [];
    const fetchImpl = vi.fn(async (input: string, init: RequestInit) => {
      const url = new URL(input);
      const headers = new Headers(init.headers);
      const verdict = await runGate({
        host: url.host,
        target: `${url.pathname}${url.search}`,
        secFetchDest: headers.get('sec-fetch-dest') ?? undefined,
      });
      verdicts.push(verdict);
      return new Response(null, { status: verdict.status === 200 ? 200 : verdict.status });
    });
    const clock = fakeClock();
    const ok = await waitForReviewHostReachable(HOST, {
      sharedServer: true,
      originIp: '',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: clock.now,
      sleep: clock.sleep,
      signalFactory: noSignal,
    });
    expect(verdicts[0]).toMatchObject({ status: 200, via: 'token' });
    expect(ok).toBe(true);
  });
});

describe('shared-server review probe: per-attempt entry token', () => {
  const prevSecret = process.env.NEXTAUTH_SECRET;

  beforeEach(() => {
    process.env.NEXTAUTH_SECRET = SECRET;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-09T20:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (prevSecret === undefined) delete process.env.NEXTAUTH_SECRET;
    else process.env.NEXTAUTH_SECRET = prevSecret;
  });

  function tokenOf(url: string): string | null {
    return new URL(url.replace(/^http:\/\/[^/]+/, 'http://x')).searchParams.get('mr');
  }

  it('mints a FRESH host-bound token on every attempt, sent as an entry (document) request', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const statuses = [401, 404, 200];
    const probe: OriginProbe = async (url, init) => {
      calls.push({ url, headers: init.headers });
      return { status: statuses[calls.length - 1] };
    };
    // The loop's clock and the wall clock (which the token's exp reads) advance together.
    let t = 0;
    const ok = await waitForReviewHostReachable(HOST, {
      sharedServer: true,
      originIp: '192.0.2.10',
      originProbe: probe,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
        vi.setSystemTime(Date.now() + ms);
      },
      signalFactory: noSignal,
    });
    expect(ok).toBe(true);
    expect(calls).toHaveLength(3);

    const tokens = calls.map((c) => tokenOf(c.url));
    expect(tokens.every((tk) => typeof tk === 'string' && tk.length > 0)).toBe(true);
    // One token per attempt, none reused.
    expect(new Set(tokens).size).toBe(3);
    for (const c of calls) {
      expect(c.headers).toEqual({ Host: HOST, 'Sec-Fetch-Dest': 'document' });
      const tk = tokenOf(c.url)!;
      // Bound to THIS host, and to the system sentinel id, never to a real user.
      expect(verifyReviewAccessToken(tk, HOST, { secret: SECRET })).toEqual({
        ok: true,
        modUserId: -1,
      });
      expect(
        verifyReviewAccessToken(tk, 'review-ffffffffffffffff.civit.ai', { secret: SECRET }).ok
      ).toBe(false);
    }
  });

  it('never writes a minted token to the console, on success or on give-up', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined)
    );
    const seen: string[] = [];
    const make = (statuses: number[]): OriginProbe => {
      let n = 0;
      return async (url) => {
        seen.push(url);
        return { status: statuses[Math.min(n++, statuses.length - 1)] };
      };
    };
    const clock = fakeClock();
    await waitForReviewHostReachable(HOST, {
      sharedServer: true,
      originIp: '192.0.2.10',
      originProbe: make([401]),
      now: clock.now,
      sleep: clock.sleep,
      signalFactory: noSignal,
    });
    await waitForReviewHostReachable(HOST, {
      sharedServer: true,
      originIp: '192.0.2.10',
      originProbe: make([200]),
      now: fakeClock().now,
      sleep: fakeClock().sleep,
      signalFactory: noSignal,
    });
    const tokens = seen.map(tokenOf).filter((tk): tk is string => !!tk);
    // Positive control: tokens WERE minted, so "none logged" is not vacuous.
    expect(tokens.length).toBeGreaterThan(1);
    const logged = spies
      .flatMap((s) => s.mock.calls)
      .map((args) => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
      .join('\n');
    for (const tk of tokens) expect(logged.includes(tk)).toBe(false);
    expect(logged.includes('mr=')).toBe(false);
  });
});
