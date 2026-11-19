// ~/env/server also loads the dev .env files before @civitai/email's lazy first read of
// process.env.
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
