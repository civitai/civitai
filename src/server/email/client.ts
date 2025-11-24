import nodemailer from 'nodemailer';
import { env } from '~/env/server';
import { removeTags } from '~/utils/string-helpers';

const shouldConnect =
  !env.IS_BUILD &&
  env.EMAIL_HOST &&
  env.EMAIL_PORT &&
  env.EMAIL_USER &&
  env.EMAIL_PASS &&
  env.EMAIL_FROM;
const client = shouldConnect
  ? nodemailer.createTransport({
      pool: true,
      maxConnections: 30, // default 5
      maxMessages: 600, // default 100
      host: env.EMAIL_HOST,
      port: env.EMAIL_PORT,
      secure: env.EMAIL_SECURE,
      auth: {
        user: env.EMAIL_USER,
        pass: env.EMAIL_PASS,
      },
    })
  : null;

export async function sendEmail({
  to,
  from,
  text,
  ...data
}: {
  to: string | string[] | null;
  from?: string;
  subject: string;
  text?: string;
  html: string;
}) {
  if (!client || !to) return;
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
