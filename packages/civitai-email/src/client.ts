// SMTP transport + sendEmail primitive — the email infrastructure shared by every Civitai
// app (main, the SvelteKit auth hub, future apps). API mirrors the app's original
// src/server/email/client.ts so call-sites migrate as a drop-in.
//
// The transport is built LAZILY on first send (not at module load), so importing this never
// opens a pool — that replaces the old `!env.IS_BUILD` guard (build-detection is the app's job;
// here, absent EMAIL_* simply yields a null transport that no-ops).
import nodemailer, { type Transporter } from 'nodemailer';
import { loadEmailEnv } from './env';
import { removeTags } from './string';

let _client: Transporter | null | undefined;

function getClient(): Transporter | null {
  if (_client !== undefined) return _client;
  const env = loadEmailEnv();
  const configured =
    env.EMAIL_HOST && env.EMAIL_PORT && env.EMAIL_USER && env.EMAIL_PASS && env.EMAIL_FROM;
  _client = configured
    ? nodemailer.createTransport({
        pool: true,
        maxConnections: 30, // default 5
        maxMessages: 600, // default 100
        host: env.EMAIL_HOST,
        port: env.EMAIL_PORT,
        secure: env.EMAIL_SECURE,
        auth: { user: env.EMAIL_USER!, pass: env.EMAIL_PASS! },
        // Nodemailer waits 2 min to connect, 30 s for the greeting and 10 min of socket silence by
        // default, and callers (the auth hub's sign-in) await the send. A healthy relay greets in
        // milliseconds. EMAIL_TIMEOUTS=off (or 0 / false, any case) restores nodemailer's defaults.
        ...(['off', '0', 'false'].includes((env.EMAIL_TIMEOUTS ?? '').trim().toLowerCase())
          ? {}
          : { connectionTimeout: 5_000, greetingTimeout: 5_000, socketTimeout: 30_000 }),
      })
    : null;
  return _client;
}

export interface SendEmailInput {
  to: string | string[] | null;
  cc?: string | string[] | null;
  from?: string;
  subject: string;
  text?: string;
  html: string;
  headers?: Record<string, string>;
}

function compose(
  client: Transporter,
  { to, cc, from, text, ...data }: SendEmailInput & { to: string | string[] }
) {
  const env = loadEmailEnv();
  return client.sendMail({
    to: Array.isArray(to) ? to.join(', ') : to,
    ...(cc ? { cc: Array.isArray(cc) ? cc.join(', ') : cc } : {}),
    from: from ?? env.EMAIL_FROM,
    text: text ?? removeTags(data.html),
    ...data,
  });
}

export async function sendEmail(input: SendEmailInput): Promise<void> {
  const client = getClient();
  if (!client || !input.to) return;
  const info = await compose(client, { ...input, to: input.to });
  const failed = (info.rejected ?? []).filter(Boolean);
  if (failed.length) {
    throw new Error(`Email(s) (${failed.join(', ')}) could not be sent`);
  }
}

export interface SendEmailStrictInput extends SendEmailInput {
  to: string | string[];
  replyTo?: string;
}

/** Thrown by sendEmailStrict when EMAIL_* is not configured, so a send that cannot happen is never silent. */
export class EmailNotConfiguredError extends Error {
  constructor() {
    super('Email is not configured');
    this.name = 'EmailNotConfiguredError';
  }
}

/**
 * sendEmail for senders that keep a record of each message: it throws instead of returning when
 * nothing can be sent, and returns the relay's message id. Its errors name no address, so they can
 * be stored and logged.
 */
export async function sendEmailStrict(input: SendEmailStrictInput): Promise<{ messageId: string }> {
  const client = getClient();
  if (!client) throw new EmailNotConfiguredError();
  const recipients = Array.isArray(input.to)
    ? input.to.filter(Boolean)
    : [input.to].filter(Boolean);
  if (!recipients.length) throw new Error('Email has no recipient');
  const info = await compose(client, { ...input, to: recipients });
  const failed = (info.rejected ?? []).filter(Boolean);
  if (failed.length) throw new Error(`${failed.length} recipient(s) could not be sent to`);
  if (!info.messageId) throw new Error('Email relay returned no message id');
  return { messageId: info.messageId };
}

/** True when SMTP creds are present (the transport will actually send). */
export function isEmailConfigured(): boolean {
  return getClient() !== null;
}
