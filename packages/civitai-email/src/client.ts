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
      })
    : null;
  return _client;
}

export interface SendEmailInput {
  to: string | string[] | null;
  from?: string;
  subject: string;
  text?: string;
  html: string;
}

export async function sendEmail({ to, from, text, ...data }: SendEmailInput): Promise<void> {
  const client = getClient();
  if (!client || !to) return;
  const env = loadEmailEnv();
  const info = await client.sendMail({
    to: Array.isArray(to) ? to.join(', ') : to,
    from: from ?? env.EMAIL_FROM,
    text: text ?? removeTags(data.html),
    ...data,
  });
  const failed = info.rejected.filter(Boolean);
  if (failed.length) {
    throw new Error(`Email(s) (${failed.join(', ')}) could not be sent`);
  }
}

/** True when SMTP creds are present (the transport will actually send). */
export function isEmailConfigured(): boolean {
  return getClient() !== null;
}
