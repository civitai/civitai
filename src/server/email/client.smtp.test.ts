import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The real pooled SMTP transport, end to end, against a local SMTP sink: EHLO, AUTH, MAIL, RCPT and
// DATA over a socket. client.test.ts swaps the socket for jsonTransport, so it cannot see a change
// in how the pool connects, authenticates or negotiates.

const env = vi.hoisted(() => ({
  IS_BUILD: false,
  EMAIL_HOST: '127.0.0.1',
  EMAIL_PORT: 0,
  EMAIL_SECURE: false,
  EMAIL_USER: 'user',
  EMAIL_PASS: 'pass',
  EMAIL_FROM: 'Civitai <noreply@test.dev>',
}));
vi.mock('~/env/server', () => ({ env }));

type Received = { auth: string; from: string; rcpt: string[]; data: string };

function startSink() {
  const received: Received[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buffer = '';
    let inData = false;
    let current: Received = { auth: '', from: '', rcpt: [], data: '' };
    const reply = (line: string) => socket.write(`${line}\r\n`);
    reply('220 sink ESMTP');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index: number;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            received.push(current);
            current = { auth: current.auth, from: '', rcpt: [], data: '' };
            reply('250 queued');
          } else current.data += `${line}\n`;
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO') {
          socket.write('250-sink\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
        } else if (verb === 'AUTH') {
          current.auth = Buffer.from(line.split(' ')[2] ?? '', 'base64').toString('utf8');
          reply('235 ok');
        } else if (verb === 'MAIL') {
          current.from = line;
          reply('250 ok');
        } else if (verb === 'RCPT') {
          current.rcpt.push(line);
          reply('250 ok');
        } else if (verb === 'DATA') {
          inData = true;
          reply('354 go');
        } else if (verb === 'QUIT') {
          reply('221 bye');
          socket.end();
        } else reply('250 ok');
      }
    });
  });
  // The pool keeps its connection open, so close() would wait on it forever.
  const close = () =>
    new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    });
  return new Promise<{ port: number; received: Received[]; close: () => Promise<void> }>(
    (resolve) =>
      server.listen(0, '127.0.0.1', () =>
        resolve({ port: (server.address() as net.AddressInfo).port, received, close })
      )
  );
}

describe('sendEmail over SMTP', () => {
  let sink: Awaited<ReturnType<typeof startSink>>;

  beforeAll(async () => {
    sink = await startSink();
    env.EMAIL_PORT = sink.port;
  });
  afterAll(() => sink.close());

  it('authenticates and delivers through the pooled transport', async () => {
    const { sendEmail } = await import('~/server/email/client');

    await sendEmail({
      to: ['a@test.dev', 'b@test.dev'],
      subject: 'Hello',
      html: '<p>Body</p>',
    });

    expect(sink.received).toHaveLength(1);
    const [message] = sink.received;
    expect(message.auth).toBe('\0user\0pass');
    expect(message.from).toBe('MAIL FROM:<noreply@test.dev>');
    expect(message.rcpt).toEqual(['RCPT TO:<a@test.dev>', 'RCPT TO:<b@test.dev>']);
    expect(message.data).toMatch(/^Subject: Hello$/m);
    expect(message.data).toContain('<p>Body</p>');
  });
});
