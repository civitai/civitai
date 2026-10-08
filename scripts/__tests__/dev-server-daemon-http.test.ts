import { ClientRequest, createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Imported by path: it runs under plain node and is never bundled.
import {
  DAEMON_TIMEOUT_MS,
  daemonFetch,
} from '../../.claude/skills/dev-server/scripts/daemon-http.mjs';

let server: Server | undefined;

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  server = undefined;
});

async function listen(handler: Parameters<typeof createServer>[1]) {
  server = createServer(handler);
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

describe('daemonFetch', () => {
  it('answers in the fetch shape the waiters read: ok, status and json()', async () => {
    const base = await listen((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        res.writeHead(req.url === '/missing' ? 404 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, body, type: req.headers['content-type'] }));
      });
    });

    const posted = await daemonFetch(`${base}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"a":"é"}',
    });
    expect(posted).toMatchObject({ ok: true, status: 200 });
    expect(await posted.json()).toEqual({
      method: 'POST',
      body: '{"a":"é"}',
      type: 'application/json',
    });

    const missing = await daemonFetch(`${base}/missing`);
    expect(missing).toMatchObject({ ok: false, status: 404 });
  });

  // Every cli.mjs and console.mjs daemon call uses this default. It stands in for fetch's implicit
  // 300s, so a shorter one makes a slow daemon fail calls that fetch would have waited out.
  it('waits at least as long as fetch did by default', async () => {
    expect(DAEMON_TIMEOUT_MS).toBeGreaterThanOrEqual(300_000);

    const armed = vi.spyOn(ClientRequest.prototype, 'setTimeout');
    const base = await listen((_req, res) => res.end('{}'));
    try {
      await daemonFetch(`${base}/`);
      expect(armed).toHaveBeenCalledWith(DAEMON_TIMEOUT_MS, expect.any(Function));
    } finally {
      armed.mockRestore();
    }
  });

  // `fetch` gave up after undici's implicit 300s; `http.request` has no timeout of its own, so a
  // daemon that accepts and never answers would hang a waiter forever without this.
  it('rejects when the daemon accepts and never answers', { timeout: 5_000 }, async () => {
    const base = await listen(() => undefined);

    await expect(daemonFetch(`${base}/hang`, { timeoutMs: 200 })).rejects.toThrow(
      'daemon did not answer within 0.2s'
    );
  });

  it('rejects when nothing is listening', async () => {
    const base = await listen(() => undefined);
    await new Promise<void>((done) => server!.close(() => done()));
    server = undefined;

    await expect(daemonFetch(`${base}/`)).rejects.toThrow();
  });
});
