import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmailSendRecord, SendEmailInput } from '../client';

// client.ts builds a pooled SMTP transport. Here nodemailer's createTransport is wrapped so the
// SMTP options are recorded and the send itself goes through nodemailer's JSON transport: the
// message is composed by the real library, with no network. The JSON transport reports no
// `rejected` list, so one is added the way an SMTP transport reports it.
const seen = vi.hoisted(() => ({
  options: [] as unknown[],
  messages: [] as string[],
  rejected: [] as string[],
  fail: false,
}));

vi.mock('nodemailer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('nodemailer')>();
  const createTransport = (options: unknown) => {
    seen.options.push(options);
    const json = actual.default.createTransport({ jsonTransport: true });
    return {
      sendMail: async (mail: Parameters<typeof json.sendMail>[0]) => {
        if (seen.fail) throw new Error('relay unreachable');
        const info = await json.sendMail(mail);
        seen.messages.push(String(info.message));
        return { ...info, rejected: seen.rejected };
      },
    };
  };
  return { ...actual, default: { ...actual.default, createTransport } };
});

const TAGS = { template: 'test', mailClass: 'transactional' } as const;

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
    await sendEmail({ to: 'a@example.test', subject: 'Hi', html: '<p>Hello</p>', tags: TAGS });
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
    await (
      await load()
    ).sendEmail({ to: 'a@example.test', subject: 'Hi', html: '<p>Hi</p>', tags: TAGS });
    expect(seen.options.at(-1)).toMatchObject({ secure });
  });

  it.each(['off', 'OFF', '0', 'false'])(
    'bounds the SMTP connect, greeting and socket waits; EMAIL_TIMEOUTS=%s drops them',
    async (value) => {
      const bounds = { connectionTimeout: 5_000, greetingTimeout: 5_000, socketTimeout: 30_000 };
      await (
        await load()
      ).sendEmail({ to: 'a@example.test', subject: 'Hi', html: '<p>Hi</p>', tags: TAGS });
      expect(seen.options.at(-1)).toMatchObject(bounds);

      process.env.EMAIL_TIMEOUTS = value;
      await (
        await load()
      ).sendEmail({ to: 'a@example.test', subject: 'Hi', html: '<p>Hi</p>', tags: TAGS });
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
      tags: TAGS,
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
      sendEmail({ to: 'bad@example.test', subject: 'Hi', html: '<p>Hello</p>', tags: TAGS })
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
      sendEmailStrict({ to: 'a@example.test', subject: 'Hi', html: '<p>Hi</p>', tags: TAGS })
    ).rejects.toBeInstanceOf(EmailNotConfiguredError);
    expect(seen.messages).toHaveLength(0);
  });

  it('throws when there is no recipient', async () => {
    const { sendEmailStrict } = await load();
    await expect(
      sendEmailStrict({ to: [], subject: 'Hi', html: '<p>Hi</p>', tags: TAGS })
    ).rejects.toThrow('no recipient');
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
      tags: TAGS,
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
      tags: TAGS,
    }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('1 recipient');
    expect((error as Error).message).not.toContain('bad@example.test');
  });
});

describe('send rows', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    seen.options.length = 0;
    seen.messages.length = 0;
    seen.rejected = [];
    seen.fail = false;
    Object.assign(process.env, ENV);
  });
  afterEach(() => {
    vi.useRealTimers();
    process.env = { ...saved };
  });

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const tags = {
    template: 'trainingComplete',
    mailClass: 'lifecycle',
    campaign: 'c-2026-11',
    variant: 'b',
    userId: 42,
  } as const;
  const input = {
    to: ['first@example.test', 'second@example.test'],
    cc: 'third@example.test',
    subject: 'Hi',
    html: '<p>Hello</p>',
    tags,
  };
  const headerOf = (raw: string) => JSON.parse(raw).headers['X-Civitai-Send-Id'] as string;

  it.each(['sendEmail', 'sendEmailStrict'] as const)(
    '%s records one row on success, keyed by the send id the message carries, naming no address',
    async (fn) => {
      const mod = await load();
      const rows: EmailSendRecord[] = [];
      mod.setEmailSendRecorder((r) => void rows.push(r));
      await mod[fn](input);
      expect(seen.messages).toHaveLength(1);
      const sendId = headerOf(seen.messages[0]);
      expect(sendId).toMatch(UUID);
      expect(rows).toEqual([
        {
          sendId,
          sentAt: expect.any(Date),
          template: 'trainingComplete',
          mailClass: 'lifecycle',
          campaign: 'c-2026-11',
          variant: 'b',
          userId: 42,
        },
      ]);
      expect(JSON.stringify(rows)).not.toMatch(/@|example\.test|first|second|third/);
    }
  );

  it('gives every message its own send id, and the caller cannot set it', async () => {
    const mod = await load();
    const rows: EmailSendRecord[] = [];
    mod.setEmailSendRecorder((r) => void rows.push(r));
    const headers = { 'X-Civitai-Send-Id': 'forged', 'List-Unsubscribe': '<https://u.test>' };
    await mod.sendEmail({ ...input, headers });
    await mod.sendEmail({ ...input, headers });
    const ids = seen.messages.map(headerOf);
    expect(ids[0]).toMatch(UUID);
    expect(ids[1]).toMatch(UUID);
    expect(ids[0]).not.toBe(ids[1]);
    expect(rows.map((r) => r.sendId)).toEqual(ids);
    expect(JSON.parse(seen.messages[0]).headers['List-Unsubscribe']).toBe('<https://u.test>');
  });

  it('defaults what a send does not say: no campaign or variant, user 0', async () => {
    const mod = await load();
    const rows: EmailSendRecord[] = [];
    mod.setEmailSendRecorder((r) => void rows.push(r));
    await mod.sendEmail({ ...input, tags: { template: 'x', mailClass: 'transactional' } });
    expect(rows[0]).toMatchObject({ campaign: '', variant: '', userId: 0 });
  });

  it.each(['sendEmail', 'sendEmailStrict'] as const)(
    '%s records nothing when the relay rejects a recipient or the transport throws',
    async (fn) => {
      const mod = await load();
      const recorder = vi.fn();
      mod.setEmailSendRecorder(recorder);
      seen.rejected = ['first@example.test'];
      await expect(mod[fn](input)).rejects.toThrow();
      seen.rejected = [];
      seen.fail = true;
      await expect(mod[fn](input)).rejects.toThrow('relay unreachable');
      expect(recorder).not.toHaveBeenCalled();
    }
  );

  it('records nothing for a send that never happens (no recipient)', async () => {
    const mod = await load();
    const recorder = vi.fn();
    mod.setEmailSendRecorder(recorder);
    await mod.sendEmail({ ...input, to: null });
    expect(seen.messages).toHaveLength(0);
    expect(recorder).not.toHaveBeenCalled();
  });

  it.each([
    [
      'throws',
      () => {
        throw new Error('boom');
      },
    ],
    [
      'rejects',
      async () => {
        throw new Error('boom');
      },
    ],
  ])('a recorder that %s never fails the send', async (_how, recorder) => {
    const mod = await load();
    mod.setEmailSendRecorder(recorder);
    await expect(mod.sendEmail(input)).resolves.toBeUndefined();
    await expect(mod.sendEmailStrict(input)).resolves.toMatchObject({
      messageId: expect.any(String),
    });
  });

  it('waits on a recorder that hangs for at most EMAIL_SEND_RECORD_TIMEOUT_MS', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const mod = await load();
    expect(mod.EMAIL_SEND_RECORD_TIMEOUT_MS).toBe(2000);
    let called!: () => void;
    const reached = new Promise<void>((resolve) => (called = resolve));
    mod.setEmailSendRecorder(() => {
      called();
      return new Promise(() => undefined);
    });
    let done = false;
    const sending = mod.sendEmail(input).then(() => (done = true));
    await reached;
    await vi.advanceTimersByTimeAsync(1999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await sending;
    expect(done).toBe(true);
  });

  it('a send without its template and mail class does not typecheck', () => {
    // @ts-expect-error - `tags` is required: an untagged sender fails typecheck:tests (TS2578
    // here instead, if the requirement is ever dropped).
    const untagged: SendEmailInput = { to: 'a@example.test', subject: 'Hi', html: '<p>Hi</p>' };
    // @ts-expect-error - a mail class is one of the two.
    const wrongClass: SendEmailInput = { ...untagged, tags: { template: 'x', mailClass: 'promo' } };
    expect([untagged, wrongClass]).toHaveLength(2);
  });
});
