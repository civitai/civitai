// @civitai/email — SMTP transport + sendEmail primitive + createEmail factory. Infra package
// (external deps only, no app imports); branded templates stay in each app.
export { loadEmailEnv } from './env';
export type { EmailEnv } from './env';
export { sendEmail, sendEmailStrict, EmailNotConfiguredError, isEmailConfigured } from './client';
export type { SendEmailInput, SendEmailStrictInput } from './client';
export {
  NOTICE_MIN_INTERVAL_MS,
  THROTTLE_RETRY_DELAYS_MS,
  isThrottlingError,
  withThrottleRetry,
} from './pacing';
export type { Sleep } from './pacing';
export { createEmail } from './create-email';
export type { Email } from './create-email';
export { removeTags } from './string';
export { default as addressparser } from 'nodemailer/lib/addressparser/index.js';
