import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// client.ts builds a pooled SMTP transport. Here nodemailer's createTransport is wrapped so the
// SMTP options are recorded and the send itself goes through nodemailer's JSON transport: the
// message is composed by the real library, with no network. The JSON transport reports no
// `rejected` list, so one is added the way an SMTP transport reports it.
const seen = vi.hoisted(() => ({
  options: [] as unknown[],
  messages: [] as string[],
  rejected: [] as string[],
}));

vi.mock('nodemailer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('nodemailer')>();
  const createTransport = (options: unknown) => {
    seen.options.push(options);
    const json = actual.default.createTransport({ jsonTransport: true });
    return {
      sendMail: async (mail: Parameters<typeof json.sendMail>[0]) => {
        const info = await json.sendMail(mail);
        seen.messages.push(String(info.message));
        return { ...info, rejected: seen.rejected };
      },
    };
  };
  return { ...actual, default: { ...actual.default, createTransport } };
});

const ENV = {
  EMAIL_HOST: 'smtp.example.test',
  EMAIL_PORT: '587',
  EMAIL_USER: 'user',
  EMAIL_PASS: 'pass',
  EMAIL_FROM: 'Civitai <noreply@example.test>',
};

async function load() {
  vi.resetModules(); // client.ts and env.ts memoize on first use
  return import('../client');
}

describe('sendEmail', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    seen.options.length = 0;
    seen.messages.length = 0;
    seen.rejected = [];
    Object.assign(process.env, ENV);
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('builds the pooled SMTP transport from the EMAIL_* env', async () => {
    const { sendEmail } = await load();
    await sendEmail({ to: 'a@example.test', subject: 'Hi', html: '<p>Hello</p>' });
    expect(seen.options).toEqual([
      expect.objectContaining({
        pool: true,
        host: ENV.EMAIL_HOST,
        port: 587,
        secure: false,
        auth: { user: 'user', pass: 'pass' },
      }),
    ]);
  });

  it('composes one message for every recipient, from EMAIL_FROM, with html and a text fallback', async () => {
    const { sendEmail } = await load();
    await sendEmail({
      to: ['a@example.test', 'b@example.test'],
      subject: 'Verify your email',
      html: '<p>Hello <b>there</b></p>',
    });
    expect(seen.messages).toHaveLength(1);
    const message = JSON.parse(seen.messages[0]);
    expect(message.to.map((r: { address: string }) => r.address)).toEqual([
      'a@example.test',
      'b@example.test',
    ]);
    expect(message.from).toEqual({ name: 'Civitai', address: 'noreply@example.test' });
    expect(message.subject).toBe('Verify your email');
    expect(message.html).toBe('<p>Hello <b>there</b></p>');
    expect(message.text).toContain('Hello');
  });

  it('throws when the server rejects a recipient', async () => {
    seen.rejected = ['bad@example.test'];
    const { sendEmail } = await load();
    await expect(
      sendEmail({ to: 'bad@example.test', subject: 'Hi', html: '<p>Hello</p>' })
    ).rejects.toThrow('bad@example.test');
  });
});
