import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { createFliptClient } from '../client';

// The REAL SDK (its node build, whose `init` starts a `setInterval` config poller) against a real
// HTTP server that answers every request after 150ms. The poller is observed from the outside: each
// poll is a request the server counts. Real timers, so this takes ~3s.

const snapshot = {
  namespace: { key: 'default' },
  flags: [
    {
      key: 'f',
      name: '',
      description: '',
      enabled: true,
      type: 'BOOLEAN_FLAG_TYPE',
      rules: [],
      rollouts: [],
    },
  ],
};

const servers: Server[] = [];
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A Flipt that answers after `delayMs`, and how many requests it has had. */
async function slowFlipt(delayMs: number) {
  const seen = { requests: 0 };
  const server = createServer((_req, res) => {
    seen.requests++;
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(snapshot));
    }, delayMs);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const client = (url: string, initTimeoutMs: number) =>
  createFliptClient({
    url,
    clientToken: 'token',
    environment: 'test-env',
    localOverrides: {},
    updateIntervalSeconds: 1,
    initTimeoutMs,
    log: () => {},
    onInitError: () => {},
  });

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
  );
});

describe('real SDK: a client that arrives after the init timeout', () => {
  // Positive control: the instrument CAN see the poller. A client that wins the race polls.
  it('control — a client that wins the race keeps polling (the server sees the polls)', async () => {
    const flipt = await slowFlipt(150);
    const c = client(flipt.url, 5000);
    expect(await c.isEnabled('f')).toBe(true);
    const afterInit = flipt.seen.requests; // the init fetch + the refresh
    await wait(2300);
    expect(flipt.seen.requests).toBeGreaterThan(afterInit);
    c.getClientSync()?.close();
  });

  it('is closed: its poller stops, so the server sees no polls after init', async () => {
    const flipt = await slowFlipt(150);
    const c = client(flipt.url, 50);
    expect(await c.isEnabled('f')).toBe(false); // the 50ms timeout won
    await wait(600); // the late client arrives (init fetch + refresh, 150ms each) and is closed
    const afterInit = flipt.seen.requests;
    expect(afterInit).toBe(2);
    await wait(2300); // two poll intervals
    expect(flipt.seen.requests).toBe(afterInit);
  });
});
