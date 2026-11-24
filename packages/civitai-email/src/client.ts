// SMTP transport + sendEmail primitive — the email infrastructure shared by every Civitai
// app (main, the SvelteKit auth hub, future apps). API mirrors the app's original
// src/server/email/client.ts so call-sites migrate as a drop-in.
//
// The transport is built LAZILY on first send (not at module load), so importing this never
// opens a pool — that replaces the old `!env.IS_BUILD` guard (build-detection is the app's job;
// here, absent EMAIL_* simply yields a null transport that no-ops).
import { randomUUID } from 'node:crypto';
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

/** `transactional`: mail a user needs or asked for. `lifecycle`: engagement mail. */
export const MAIL_CLASSES = ['transactional', 'lifecycle'] as const;
export type MailClass = (typeof MAIL_CLASSES)[number];

/** What one message is, for measurement. Never an address. */
export interface EmailTags {
  /** The sender's stable key (a template's, or a named one-off sender's). */
  template: string;
  mailClass: MailClass;
  campaign?: string;
  variant?: string;
  /** The recipient's user id, when the sender knows it. */
  userId?: number;
}

/**
 * Our own per-send id, set on every message. The relay replaces the Message-ID, so a later
 * delivery or bounce event can only be joined back to its send row through this header.
 */
export const SEND_ID_HEADER = 'X-Civitai-Send-Id';

export interface SendEmailInput {
  to: string | string[] | null;
  cc?: string | string[] | null;
  from?: string;
  subject: string;
  text?: string;
  html: string;
  headers?: Record<string, string>;
  /** Required: a send without a template and mail class is a type error. */
  tags: EmailTags;
}

/** One send, as handed to the recorder: the tags and our send id, never an address or content. */
export interface EmailSendRecord {
  sendId: string;
  sentAt: Date;
  template: string;
  mailClass: MailClass | '';
  campaign: string;
  variant: string;
  userId: number;
}
export type EmailSendRecorder = (record: EmailSendRecord) => unknown;

let _recorder: EmailSendRecorder | null = null;

/**
 * Sets the function told of every successful send (null clears it). An app that writes send rows
 * registers one; without it nothing is recorded. The send never waits on it: a recorder that
 * throws, rejects or hangs costs a missing row, never a failed or delayed send.
 */
export function setEmailSendRecorder(recorder: EmailSendRecorder | null) {
  _recorder = recorder;
}

export function getEmailSendRecorder(): EmailSendRecorder | null {
  return _recorder;
}

export function emailSendRecord(sendId: string, tags: EmailTags | undefined, sentAt: Date) {
  const userId = tags?.userId;
  return {
    sendId,
    sentAt,
    template: tags?.template ?? '',
    mailClass: tags?.mailClass && MAIL_CLASSES.includes(tags.mailClass) ? tags.mailClass : '',
    campaign: tags?.campaign ?? '',
    variant: tags?.variant ?? '',
    // emailEvents.userId is a UInt32: anything outside it is recorded as unknown.
    userId: Number.isInteger(userId) && userId! > 0 && userId! <= 0xffffffff ? userId! : 0,
  } satisfies EmailSendRecord;
}

// Fire-and-forget: the recorder is started and never awaited. Its errors are swallowed here (it
// logs its own), and its promise gets a handler, so a late rejection is never unhandled.
function recordSend(record: EmailSendRecord) {
  const recorder = _recorder;
  if (!recorder) return;
  try {
    Promise.resolve(recorder(record)).catch(() => undefined);
  } catch {
    // A recorder that throws synchronously costs the row, never the send.
  }
}

function compose(
  client: Transporter,
  sendId: string,
  { to, cc, from, text, tags, headers, ...data }: SendEmailInput & { to: string | string[] }
) {
  const env = loadEmailEnv();
  return client.sendMail({
    to: Array.isArray(to) ? to.join(', ') : to,
    ...(cc ? { cc: Array.isArray(cc) ? cc.join(', ') : cc } : {}),
    from: from ?? env.EMAIL_FROM,
    text: text ?? removeTags(data.html),
    ...data,
    // Ours wins over a caller's in any casing: nodemailer appends headers, so a differently-cased
    // key would otherwise go out as a second send id.
    headers: {
      ...Object.fromEntries(
        Object.entries(headers ?? {}).filter(
          ([key]) => key.toLowerCase() !== SEND_ID_HEADER.toLowerCase()
        )
      ),
      [SEND_ID_HEADER]: sendId,
    },
  });
}

export async function sendEmail(input: SendEmailInput): Promise<void> {
  const client = getClient();
  if (!client || !input.to) return;
  const sendId = randomUUID();
  const info = await compose(client, sendId, { ...input, to: input.to });
  const failed = (info.rejected ?? []).filter(Boolean);
  if (failed.length) {
    throw new Error(`Email(s) (${failed.join(', ')}) could not be sent`);
  }
  recordSend(emailSendRecord(sendId, input.tags, new Date()));
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
  const sendId = randomUUID();
  const info = await compose(client, sendId, { ...input, to: recipients });
  const failed = (info.rejected ?? []).filter(Boolean);
  if (failed.length) throw new Error(`${failed.length} recipient(s) could not be sent to`);
  if (!info.messageId) throw new Error('Email relay returned no message id');
  recordSend(emailSendRecord(sendId, input.tags, new Date()));
  return { messageId: info.messageId };
}

/** True when SMTP creds are present (the transport will actually send). */
export function isEmailConfigured(): boolean {
  return getClient() !== null;
}
