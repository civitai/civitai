import type { Server, ListenOptions } from 'net';
import { createServer } from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

// A port the OS itself refuses to bind (EACCES) — a Hyper-V excluded range on Windows, a
// privileged port when running unprivileged. Nothing is listening on one, so connect alone
// calls it free. Returns null when the host hands out everything it is asked for.
async function findBindRefusedPort(): Promise<number | null> {
  const candidates = [1, 80, 443, ...Array.from({ length: 60 }, (_, i) => 49700 + i * 10)];
  for (const port of candidates) {
    const code = await new Promise<string | null>((resolve) => {
      const server = createServer();
      server.once('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? 'UNKNOWN'));
      server.once('listening', () => server.close(() => resolve(null)));
      server.listen({ port, host: '0.0.0.0' });
    });
    if (code === 'EACCES') return port;
  }
  return null;
}

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
    it(`reports a port held on ${label} as busy`, async (ctx) => {
      const port = await reserveEphemeralPort();
      const server = await hold({ ...options, port });
      // A silent `return` here would print a green tick for a case that never ran — and on a
      // host without IPv6 that is three of these five, including the one the fix is about.
      if (!server) return ctx.skip();
      expect(await isPortFree(port)).toBe(false);
    });
  }

  // Every case above is caught by the connect half alone, so without this one the three
  // binds could be deleted and the suite would stay green. A port the OS has reserved is
  // the state only the binds see: nothing is listening, so connect gets refused, but the
  // bind is refused too and the port is unusable.
  it('reports a port the OS refuses to hand out as busy', async (ctx) => {
    const reserved = await findBindRefusedPort();
    if (reserved === null) return ctx.skip();
    expect(await isPortFree(reserved)).toBe(false);
  });

  // The probe's transient listener accepts anything that arrives in its bind window, and
  // close() withholds its callback until every accepted connection is gone. Resolving from
  // that callback made one stray connection enough to wedge the picker, which the daemon
  // awaits inline in its POST /sessions handler — a request that never answers.
  //
  // Driving that with a real connection does not work: the bind window is sub-millisecond,
  // so a racing client lands on the probe listener too rarely to assert on. Withholding the
  // callback directly is the same defect, deterministically.
  it('does not wait for close() to acknowledge before reporting a port free', async () => {
    vi.resetModules();
    vi.doMock('net', async (importOriginal) => {
      const actual = await importOriginal<typeof import('net')>();
      return {
        ...actual,
        default: actual,
        createServer: () => {
          const server = actual.createServer();
          const realClose = server.close.bind(server);
          server.close = (() => server) as typeof server.close; // never acknowledges
          held.push({ close: realClose } as unknown as Server); // still torn down in afterEach
          return server;
        },
      };
    });
    try {
      const { isPortFree: probe } = await import(
        '../../.claude/skills/dev-server/scripts/port-probe.mjs'
      );
      const port = await reserveEphemeralPort();
      const verdict = await Promise.race([
        probe(port),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('isPortFree never resolved')), 5000)
        ),
      ]);
      expect(verdict).toBe(true);
    } finally {
      vi.doUnmock('net');
      vi.resetModules();
    }
  });
});
