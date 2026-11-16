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

  // Parity with the main app's zc.booleanString: only the exact string 'true' enables TLS.
  it.each([
    ['true', true],
    ['1', false],
    ['yes', false],
    ['TRUE', false],
    [undefined, false],
  ])('EMAIL_SECURE=%s sets secure: %s', async (value, secure) => {
    if (value === undefined) delete process.env.EMAIL_SECURE;
    else process.env.EMAIL_SECURE = value;
    await (await load()).sendEmail({ to: 'a@example.test', subject: 'Hi', html: '<p>Hi</p>' });
    expect(seen.options.at(-1)).toMatchObject({ secure });
  });

  it.each(['off', 'OFF', '0', 'false'])(
    'bounds the SMTP connect, greeting and socket waits; EMAIL_TIMEOUTS=%s drops them',
    async (value) => {
      const bounds = { connectionTimeout: 5_000, greetingTimeout: 5_000, socketTimeout: 30_000 };
      await (await load()).sendEmail({ to: 'a@example.test', subject: 'Hi', html: '<p>Hi</p>' });
      expect(seen.options.at(-1)).toMatchObject(bounds);

      process.env.EMAIL_TIMEOUTS = value;
      await (await load()).sendEmail({ to: 'a@example.test', subject: 'Hi', html: '<p>Hi</p>' });
      const off = seen.options.at(-1) as Record<string, unknown>;
      expect([off.connectionTimeout, off.greetingTimeout, off.socketTimeout]).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
    }
  );

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

describe('sendEmailStrict', () => {
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

  it('throws instead of returning when EMAIL_* is not configured', async () => {
    delete process.env.EMAIL_HOST;
    const { sendEmailStrict, EmailNotConfiguredError } = await load();
    await expect(
      sendEmailStrict({ to: 'a@example.test', subject: 'Hi', html: '<p>Hi</p>' })
    ).rejects.toBeInstanceOf(EmailNotConfiguredError);
    expect(seen.messages).toHaveLength(0);
  });

  it('throws when there is no recipient', async () => {
    const { sendEmailStrict } = await load();
    await expect(sendEmailStrict({ to: [], subject: 'Hi', html: '<p>Hi</p>' })).rejects.toThrow(
      'no recipient'
    );
    expect(seen.messages).toHaveLength(0);
  });

  it('sends with the Reply-To and returns the message id', async () => {
    const { sendEmailStrict } = await load();
    const result = await sendEmailStrict({
      to: 'a@example.test',
      from: 'Notices <notices@example.test>',
      replyTo: 'inbox@example.test',
      subject: '[TD-26-ABC123] Notice',
      html: '<p>Hello</p>',
    });
    const message = JSON.parse(seen.messages[0]);
    expect(message.replyTo).toEqual([{ name: '', address: 'inbox@example.test' }]);
    expect(message.from).toEqual({ name: 'Notices', address: 'notices@example.test' });
    expect(result.messageId).toBe(message.messageId);
    expect(result.messageId).toMatch(/@/);
  });

  it('names no address when the server rejects a recipient', async () => {
    seen.rejected = ['bad@example.test'];
    const { sendEmailStrict } = await load();
    const error = await sendEmailStrict({
      to: 'bad@example.test',
      subject: 'Hi',
      html: '<p>Hello</p>',
    }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('1 recipient');
    expect((error as Error).message).not.toContain('bad@example.test');
  });
});
