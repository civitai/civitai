import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchBlob } from '~/utils/file-utils';

/**
 * A long generator video (~150 MB) on an ordinary connection takes longer than any fixed total
 * cap, so the generator import reads with an idle timeout: it fails only when bytes stop
 * arriving. Every other caller keeps the total cap; server jobs size their leases on it.
 *
 * Timings are scaled down: a 1 s header deadline stands in for the 120 s one, with a 400 ms idle
 * window, wide enough that a loaded runner doesn't fake an idle gap between 50 ms chunks.
 */
type Plan = {
  bytes: number;
  chunk: number;
  everyMs: number;
  stallAfter?: number;
  noHeaders?: boolean;
  headersAfterMs?: number;
  status?: number;
};

const DEADLINE = 1_000;
const IDLE = 400;

const sockets = new Set<Socket>();
let server: http.Server;
let base: string;

function stream(plan: Plan, res: http.ServerResponse) {
  res.writeHead(200, { 'content-type': 'video/mp4' });
  let sent = 0;
  const timer = setInterval(() => {
    if (plan.stallAfter !== undefined && sent >= plan.stallAfter) return; // stop, keep open
    if (sent >= plan.bytes) {
      clearInterval(timer);
      res.end();
      return;
    }
    res.write(Buffer.alloc(plan.chunk));
    sent += plan.chunk;
  }, plan.everyMs);
  res.on('close', () => clearInterval(timer));
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const plan = JSON.parse(
      decodeURIComponent(new URL(req.url!, 'http://x').searchParams.get('p')!)
    ) as Plan;
    if (plan.noHeaders) return; // never answers
    if (plan.status) {
      res.writeHead(plan.status, { 'content-type': 'application/json' });
      res.end('{"error":"expired"}');
      return;
    }
    const timer = setTimeout(() => stream(plan, res), plan.headersAfterMs ?? 0);
    res.on('close', () => clearTimeout(timer));
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterAll(async () => {
  for (const s of sockets) s.destroy();
  await new Promise((r) => server.close(r));
});

const url = (plan: Plan) => `${base}?p=${encodeURIComponent(JSON.stringify(plan))}`;
// 50 KB every 50 ms for 1.5 s: longer than the deadline, never idle for long.
const STEADY: Plan = { bytes: 1_500_000, chunk: 50_000, everyMs: 50 };
const idle = { idleTimeoutMs: IDLE };

describe('fetchBlob idle timeout', () => {
  it('finishes a steady body that takes longer than the deadline', async () => {
    const blob = await fetchBlob(url(STEADY), DEADLINE, idle);

    expect(blob?.size).toBe(1_500_000);
    expect(blob?.type).toBe('video/mp4');
  });

  it('fails a body that stops arriving, naming the idle timeout', async () => {
    const started = Date.now();
    const outcome = await fetchBlob(
      url({ bytes: 1_500_000, chunk: 50_000, everyMs: 20, stallAfter: 100_000 }),
      DEADLINE,
      idle
    ).catch((e: Error) => e);

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).name).toBe('IdleTimeoutError');
    expect(Date.now() - started).toBeLessThan(IDLE * 4);
  });

  it('waits for headers up to the deadline, not the idle window', async () => {
    const blob = await fetchBlob(
      url({ bytes: 100_000, chunk: 50_000, everyMs: 20, headersAfterMs: IDLE + 200 }),
      DEADLINE,
      idle
    );

    expect(blob?.size).toBe(100_000);
  });

  it('fails when no response arrives by the deadline', async () => {
    const started = Date.now();
    const outcome = await fetchBlob(
      url({ bytes: 0, chunk: 1, everyMs: 10, noHeaders: true }),
      DEADLINE,
      idle
    ).catch((e: Error) => e);

    expect((outcome as Error).name).toBe('TimeoutError');
    expect(Date.now() - started).toBeGreaterThanOrEqual(DEADLINE - 50);
  });

  it('resolves null for an error response when asked to require OK', async () => {
    const blob = await fetchBlob(url({ bytes: 0, chunk: 1, everyMs: 10, status: 403 }), DEADLINE, {
      ...idle,
      requireOk: true,
    });

    expect(blob).toBeNull();
  });

  // Server jobs (process-vault-items, youtube, csam) budget their leases on this total cap.
  it('keeps the total cap for callers that do not opt in', async () => {
    // Control: the same body arrives in full under a cap it fits in.
    expect((await fetchBlob(url(STEADY), 5_000))?.size).toBe(1_500_000);
    expect(await fetchBlob(url(STEADY), DEADLINE)).toBeNull();
  });
});
