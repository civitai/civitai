// @civitai/email — SMTP transport + sendEmail primitive + createEmail factory. Infra package
// (external deps only, no app imports); branded templates stay in each app.
export { loadEmailEnv } from './env';
export type { EmailEnv } from './env';
export { sendEmail, isEmailConfigured } from './client';
export type { SendEmailInput } from './client';
export { createEmail } from './create-email';
export type { Email } from './create-email';
export { removeTags } from './string';
