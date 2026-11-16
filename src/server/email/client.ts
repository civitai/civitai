// Delegates to @civitai/email, the one SMTP transport in the repo (transport-ledger.test.ts fails
// on a second). Kept here: the IS_BUILD guard, and the ~/env/server import, which loads the dev
// .env files before the package's lazy first read of process.env.
import {
  isEmailConfigured as isTransportConfigured,
  sendEmail as sendWithTransport,
  type SendEmailInput,
} from '@civitai/email';
import { env } from '~/env/server';

export const isEmailConfigured = () => !env.IS_BUILD && isTransportConfigured();

export async function sendEmail(input: SendEmailInput): Promise<void> {
  if (env.IS_BUILD) return;
  await sendWithTransport(input);
}
