import { beforeEach, describe, expect, it, vi } from 'vitest';
import type nodemailer from 'nodemailer';

const { createTransport, sent } = vi.hoisted(() => ({
  createTransport: vi.fn(),
  sent: [] as Record<string, any>[],
}));

// The transport is built by @civitai/email from process.env; the app env only carries IS_BUILD.
const appEnv = vi.hoisted(() => {
  Object.assign(process.env, {
    EMAIL_HOST: 'smtp.test',
    EMAIL_PORT: '587',
    EMAIL_SECURE: 'false',
    EMAIL_USER: 'user',
    EMAIL_PASS: 'pass',
    EMAIL_FROM: 'Civitai <noreply@test.dev>',
  });
  return { IS_BUILD: false };
});
vi.mock('~/env/server', () => ({ env: appEnv }));

// Real nodemailer message building, with the SMTP socket swapped for the JSON transport.
// jsonTransport's info has no `rejected`, which sendEmail reads, so it is added here.
vi.mock('nodemailer', async () => {
  const actual = await vi.importActual<typeof nodemailer>('nodemailer');
  return {
    default: {
      ...actual,
      createTransport: (options: unknown) => {
        createTransport(options);
        const json = actual.createTransport({ jsonTransport: true });
        return {
          sendMail: async (mail: any) => {
            const info = await json.sendMail(mail);
            sent.push(JSON.parse(info.message as string));
            return { ...info, rejected: [] };
          },
        };
      },
    },
  };
});

describe('sendEmail', () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it('delivers from, to, cc, subject, html and derived text through nodemailer', async () => {
    const { sendEmail, isEmailConfigured } = await import('~/server/email/client');
    expect(isEmailConfigured()).toBe(true);

    await sendEmail({
      to: ['a@test.dev', 'b@test.dev'],
      cc: 'c@test.dev',
      subject: 'Hello',
      html: '<p>Body</p>',
      tags: { template: 'test', mailClass: 'transactional' },
    });

    expect(sent).toHaveLength(1);
    const [message] = sent;
    expect(message.from).toEqual({ name: 'Civitai', address: 'noreply@test.dev' });
    expect(message.to.map((x: any) => x.address)).toEqual(['a@test.dev', 'b@test.dev']);
    expect(message.cc.map((x: any) => x.address)).toEqual(['c@test.dev']);
    expect(message.subject).toBe('Hello');
    expect(message.html).toBe('<p>Body</p>');
    expect(message.text).toContain('Body');
  });

  it('builds the pooled SMTP transport from the email env', async () => {
    vi.resetModules(); // the transport is built once, on first use
    createTransport.mockClear();
    const { isEmailConfigured } = await import('~/server/email/client');
    expect(isEmailConfigured()).toBe(true);
    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        pool: true,
        maxConnections: 30,
        maxMessages: 600,
        host: 'smtp.test',
        port: 587,
        secure: false,
        auth: { user: 'user', pass: 'pass' },
        connectionTimeout: 5_000,
        greetingTimeout: 5_000,
        socketTimeout: 30_000,
      })
    );
  });

  it('passes custom headers through to the message', async () => {
    const { sendEmail } = await import('~/server/email/client');
    await sendEmail({
      to: 'a@test.dev',
      subject: 'Hello',
      html: '<p>Body</p>',
      headers: { 'List-Unsubscribe': '<https://example.test/u>' },
      tags: { template: 'test', mailClass: 'transactional' },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].headers).toEqual({
      'List-Unsubscribe': '<https://example.test/u>',
      'X-Civitai-Send-Id': expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });

  it('sends nothing and reports unconfigured during a build', async () => {
    appEnv.IS_BUILD = true;
    try {
      const { sendEmail, isEmailConfigured } = await import('~/server/email/client');
      expect(isEmailConfigured()).toBe(false);
      await sendEmail({
        to: 'a@test.dev',
        subject: 'Hello',
        html: '<p>Body</p>',
        tags: { template: 'test', mailClass: 'transactional' },
      });
      expect(sent).toHaveLength(0);
    } finally {
      appEnv.IS_BUILD = false;
    }
  });
});
