import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// An SMTP server that accepts the connection and never sends its greeting must fail a send in seconds.
// Nodemailer's own defaults wait 30 s for the greeting (2 min to connect, 10 min of socket silence), and
// the auth hub awaits a send inside a sign-in request. Runs the real nodemailer against a local socket.

let server: Server;
const sockets = new Set<Socket>();
let port = 0;

beforeAll(async () => {
  server = createServer((socket) => {
    sockets.add(socket); // accept, never greet
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  for (const s of sockets) s.destroy();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('sendEmail against an SMTP server that never greets', () => {
  it('rejects within 8 s', async () => {
    const saved = { ...process.env };
    Object.assign(process.env, {
      EMAIL_HOST: '127.0.0.1',
      EMAIL_PORT: String(port),
      EMAIL_USER: 'user',
      EMAIL_PASS: 'pass',
      EMAIL_FROM: 'Civitai <noreply@example.test>',
      EMAIL_SECURE: 'false',
    });
    try {
      vi.resetModules(); // client.ts and env.ts memoize on first use
      const { sendEmail } = await import('../client');
      const started = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        sendEmail({ to: 'a@example.test', subject: 'Hi', html: '<p>Hello</p>' }).then(
          () => 'sent' as const,
          (err: Error) => err
        ),
        new Promise<'hung'>((r) => (timer = setTimeout(() => r('hung'), 12_000))),
      ]);
      clearTimeout(timer);

      expect(outcome).toBeInstanceOf(Error);
      expect(Date.now() - started).toBeLessThan(8_000);
    } finally {
      process.env = saved;
    }
  }, 20_000);
});
