import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBuzzClient } from '@civitai/buzz';
import {
  BALANCE_STALE_MAX_MS,
  createBalanceDisplayReader,
} from '~/server/services/buzz-balance-display';

// Against a real local HTTP server and the real `@civitai/buzz` client, so the bound is proven to
// reach the socket: a mocked read would resolve or reject on cue whatever options it was handed.

let server: Server | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  const s = server;
  server = undefined;
  if (s)
    await new Promise<void>((resolve) => {
      s.closeAllConnections();
      s.close(() => resolve());
    });
});

/** `mode.current` decides each response: a balance, or never answering. */
async function balanceService(mode: { current: 'ok' | 'hang'; balance: number }) {
  server = createServer((_req, res) => {
    if (mode.current === 'hang') return; // accept the connection, never answer
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ User: mode.balance }));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

function reader(endpoint: string, now?: () => number) {
  const client = createBuzzClient({ endpoint });
  return createBalanceDisplayReader(
    (userId, opts) => client.getUserAccounts(userId, ['yellow'], opts),
    now
  );
}

describe('header balance read', () => {
  it('rejects in under 2.5s when the buzz service never answers and nothing is remembered', async () => {
    const endpoint = await balanceService({ current: 'hang', balance: 0 });
    const read = reader(endpoint);

    const started = Date.now();
    await expect(read(1)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_500);
  }, 10_000);

  it('does NOT serve a remembered balance by default: the fallback ships dark', async () => {
    const mode = { current: 'ok' as 'ok' | 'hang', balance: 1234 };
    const endpoint = await balanceService(mode);
    const read = reader(endpoint);

    await expect(read(7)).resolves.toEqual({ User: 1234 });
    mode.current = 'hang';
    const started = Date.now();
    await expect(read(7)).rejects.toThrow();
    // Still bounded with the fallback off.
    expect(Date.now() - started).toBeLessThan(2_500);
  }, 15_000);

  it('serves the last balance it read, in under 2.5s, while the service hangs (flag on)', async () => {
    vi.stubEnv('BUZZ_BALANCE_SERVE_STALE', 'true');
    const mode = { current: 'ok' as 'ok' | 'hang', balance: 1234 };
    const endpoint = await balanceService(mode);
    const read = reader(endpoint);

    await expect(read(7)).resolves.toEqual({ User: 1234 });
    mode.current = 'hang';
    const started = Date.now();
    await expect(read(7)).resolves.toEqual({ User: 1234 });
    expect(Date.now() - started).toBeLessThan(2_500);
    // Another user's remembered balance is never served for this one.
    await expect(read(8)).rejects.toThrow();
  }, 15_000);

  it('a healthy read always wins over the remembered one', async () => {
    const mode = { current: 'ok' as 'ok' | 'hang', balance: 500 };
    const endpoint = await balanceService(mode);
    const read = reader(endpoint);

    await read(7);
    mode.balance = 300; // a spend happened
    await expect(read(7)).resolves.toEqual({ User: 300 });
  });

  it('stops serving a remembered balance once it is older than the stale limit', async () => {
    vi.stubEnv('BUZZ_BALANCE_SERVE_STALE', 'true');
    const mode = { current: 'ok' as 'ok' | 'hang', balance: 42 };
    const endpoint = await balanceService(mode);
    let clock = 1_000_000;
    const read = reader(endpoint, () => clock);

    await read(7);
    mode.current = 'hang';
    clock += BALANCE_STALE_MAX_MS + 1;
    await expect(read(7)).rejects.toThrow();
  }, 10_000);
});
