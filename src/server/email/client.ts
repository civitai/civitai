// The main app's email entry point. It delegates to @civitai/email, which owns the one SMTP
// transport in the repo (with its connect / greeting / socket timeouts), so this app and every
// other app that sends mail share one transport configuration. transport-ledger.test.ts fails if
// a second nodemailer transport is added anywhere.
//
// @civitai/email reads the same EMAIL_HOST / EMAIL_PORT / EMAIL_SECURE / EMAIL_USER / EMAIL_PASS /
// EMAIL_FROM variables this file used to read through ~/env/server, parsed the same way. What this
// wrapper keeps from the old client is the build guard: during a Next build nothing is sent and
// email reports as not configured. Importing ~/env/server also keeps the dev-only dotenv load
// ahead of the package's first (lazy) read of process.env.
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
