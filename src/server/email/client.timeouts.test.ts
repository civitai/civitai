import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// The app's own email entry point (~/server/email/client), not @civitai/email directly, against an
// SMTP server that accepts the connection and never sends its greeting. nodemailer's defaults wait
// 30 s for the greeting (2 min to connect, 10 min of socket silence), so a transport built without
// timeouts hangs past this test's 12 s race; one built with them rejects in about 5 s.

vi.mock('~/env/server', () => ({ env: { IS_BUILD: false } }));

let server: Server;
let port = 0;
const sockets = new Set<Socket>();

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
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('~/server/email/client against an SMTP server that never greets', () => {
  it('rejects the send within 8 s instead of hanging', async () => {
    vi.stubEnv('EMAIL_HOST', '127.0.0.1');
    vi.stubEnv('EMAIL_PORT', String(port));
    vi.stubEnv('EMAIL_SECURE', 'false');
    vi.stubEnv('EMAIL_USER', 'user');
    vi.stubEnv('EMAIL_PASS', 'pass');
    vi.stubEnv('EMAIL_FROM', 'Civitai <noreply@example.test>');
    vi.stubEnv('EMAIL_TIMEOUTS', undefined);

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
  }, 20_000);
});
