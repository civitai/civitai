import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmailSendRecord } from '../client';

// The package's createEmail (used by the auth and moderator apps' templates) tags every send with
// its template key and mail class. Sends go through nodemailer's JSON transport, as in
// client.test.ts, so the row is the one the real transport hands its recorder.
vi.mock('nodemailer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('nodemailer')>();
  const createTransport = () => {
    const json = actual.default.createTransport({ jsonTransport: true });
    return {
      sendMail: async (mail: Parameters<typeof json.sendMail>[0]) => ({
        ...(await json.sendMail(mail)),
        rejected: [],
      }),
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
  vi.resetModules(); // client.ts memoizes its transport
  const client = await import('../client');
  const { createEmail } = await import('../create-email');
  const rows: EmailSendRecord[] = [];
  client.setEmailSendRecorder((r) => void rows.push(r));
  const email = createEmail({
    template: 'inviteSent',
    mailClass: 'transactional',
    header: (to: string) => ({ subject: 'Hi', to }),
    html: () => '<p>Hi</p>',
  });
  return { email, rows };
}

describe('createEmail().send', () => {
  const saved = { ...process.env };
  beforeEach(() => void Object.assign(process.env, ENV));
  afterEach(() => {
    process.env = { ...saved };
  });

  it("records the template's key and mail class, plus the caller's tags", async () => {
    const { email, rows } = await load();
    await email.send('a@example.test', { userId: 7, campaign: 'c-1', variant: 'b' });
    expect(rows).toEqual([
      {
        sendId: expect.any(String),
        sentAt: expect.any(Date),
        template: 'inviteSent',
        mailClass: 'transactional',
        campaign: 'c-1',
        variant: 'b',
        userId: 7,
      },
    ]);
  });

  it('records the template key and class when the caller adds no tags', async () => {
    const { email, rows } = await load();
    await email.send('a@example.test');
    expect(rows).toEqual([
      expect.objectContaining({ template: 'inviteSent', mailClass: 'transactional', userId: 0 }),
    ]);
  });

  it("a caller's tags cannot override the template key or mail class", async () => {
    const { email, rows } = await load();
    const forged = { userId: 7, template: 'forged', mailClass: 'lifecycle' };
    await email.send('a@example.test', forged as Parameters<typeof email.send>[1]);
    expect(rows).toEqual([
      expect.objectContaining({ template: 'inviteSent', mailClass: 'transactional', userId: 7 }),
    ]);
  });
});
