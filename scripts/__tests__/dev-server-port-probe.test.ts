import type { Server, ListenOptions } from 'net';
import { createServer } from 'net';
import { afterEach, describe, expect, it } from 'vitest';

// The probe under test ships with the dev-server skill (plain .mjs, run by the daemon under
// node, never bundled). It is imported by path rather than moved into src/ so the daemon can
// keep loading it without a build step.
import { isPortFree } from '../../.claude/skills/dev-server/scripts/port-probe.mjs';

const held: Server[] = [];

function close(server: Server) {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

afterEach(async () => {
  while (held.length) await close(held.pop()!);
});

// Bind port 0 to have the OS hand out a port nothing else is using, then rebind that same
// port in the shape under test. A fixed port number would collide with whatever else is on
// the machine and fail for reasons that have nothing to do with the probe.
async function reserveEphemeralPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port: 0, host: '127.0.0.1' }, () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  await close(server);
  return port;
}

async function hold(options: ListenOptions): Promise<Server | null> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options, () => resolve());
    });
  } catch {
    return null; // e.g. no IPv6 on this host — the case does not apply here.
  }
  held.push(server);
  return server;
}

describe('dev-server port probe', () => {
  // The negative control. Without it, a probe hardwired to `return false` would pass every
  // case below.
  it('reports a port with no listener as free', async () => {
    const port = await reserveEphemeralPort();
    expect(await isPortFree(port)).toBe(true);
  });

  // Each of these was reported FREE by the previous 127.0.0.1-bind-only probe on Windows,
  // including `::` dual-stack — which is what `next dev` actually binds.
  const occupied: Array<[string, ListenOptions]> = [
    ['`::` dual-stack (what next dev binds)', { host: '::', ipv6Only: false }],
    ['`::` IPv6-only', { host: '::', ipv6Only: true }],
    ['0.0.0.0 wildcard', { host: '0.0.0.0' }],
    ['127.0.0.1 loopback', { host: '127.0.0.1' }],
    ['::1 loopback', { host: '::1' }],
  ];

  for (const [label, options] of occupied) {
    it(`reports a port held on ${label} as busy`, async () => {
      const port = await reserveEphemeralPort();
      const server = await hold({ ...options, port });
      if (!server) return; // address family unavailable on this host
      expect(await isPortFree(port)).toBe(false);
    });
  }
});
