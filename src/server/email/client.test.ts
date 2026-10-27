import { beforeEach, describe, expect, it, vi } from 'vitest';
import type nodemailer from 'nodemailer';

const { createTransport, sent } = vi.hoisted(() => ({
  createTransport: vi.fn(),
  sent: [] as Record<string, any>[],
}));

vi.mock('~/env/server', () => ({
  env: {
    IS_BUILD: false,
    EMAIL_HOST: 'smtp.test',
    EMAIL_PORT: 587,
    EMAIL_SECURE: false,
    EMAIL_USER: 'user',
    EMAIL_PASS: 'pass',
    EMAIL_FROM: 'Civitai <noreply@test.dev>',
  },
}));

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
    await import('~/server/email/client');
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        pool: true,
        host: 'smtp.test',
        port: 587,
        secure: false,
        auth: { user: 'user', pass: 'pass' },
      })
    );
  });
});
