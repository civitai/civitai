import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The app's own email entry point (~/server/email/client), not @civitai/email directly, against an
// SMTP server that accepts the connection and never sends its greeting. nodemailer's defaults wait
// 30 s for the greeting (2 min to connect, 10 min of socket silence), so a transport built without
// timeouts hangs past this test's 12 s race; one built with them rejects in about 5 s.
//
// The EMAIL_* settings are given BOTH ways: through the mocked app env (what the old src client
// read) and through process.env (what @civitai/email reads). So the test reaches a real transport
// whichever module builds it, and the only thing it can tell apart is whether timeouts are set.

const appEnv = vi.hoisted(() => ({
  IS_BUILD: false,
  EMAIL_HOST: '127.0.0.1',
  EMAIL_PORT: 0,
  EMAIL_SECURE: false,
  EMAIL_USER: 'user',
  EMAIL_PASS: 'pass',
  EMAIL_FROM: 'Civitai <noreply@example.test>',
}));
vi.mock('~/env/server', () => ({ env: appEnv }));

let server: Server;
const sockets = new Set<Socket>();

beforeAll(async () => {
  server = createServer((socket) => {
    sockets.add(socket); // accept, never greet
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  appEnv.EMAIL_PORT = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  for (const s of sockets) s.destroy();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('~/server/email/client against an SMTP server that never greets', () => {
  it('rejects the send within 8 s instead of hanging', async () => {
    const saved = { ...process.env };
    Object.assign(process.env, {
      EMAIL_HOST: appEnv.EMAIL_HOST,
      EMAIL_PORT: String(appEnv.EMAIL_PORT),
      EMAIL_SECURE: 'false',
      EMAIL_USER: appEnv.EMAIL_USER,
      EMAIL_PASS: appEnv.EMAIL_PASS,
      EMAIL_FROM: appEnv.EMAIL_FROM,
    });
    delete process.env.EMAIL_TIMEOUTS;
    try {
      const { sendEmail } = await import('~/server/email/client');
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
