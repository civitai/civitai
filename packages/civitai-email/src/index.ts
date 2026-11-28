// @civitai/email — SMTP transport + sendEmail primitive + createEmail factory. Infra package
// (external deps only, no app imports); branded templates stay in each app, and render through the
// shared layout in ./shell.
export { loadEmailEnv } from './env';
export type { EmailEnv } from './env';
export {
  sendEmail,
  sendEmailStrict,
  EmailNotConfiguredError,
  isEmailConfigured,
  setEmailSendRecorder,
  getEmailSendRecorder,
  emailSendRecord,
  MAIL_CLASSES,
  SEND_ID_HEADER,
  resolveSendId,
  isSendId,
} from './client';
export {
  createRemoteSendRecorder,
  EMAIL_EVENTS_INTERNAL_PATH,
  REMOTE_RECORDER_TIMEOUT_MS,
} from './remote-recorder';
export type { RemoteSendRecorderOptions } from './remote-recorder';
export {
  createRemoteLinkTracker,
  setEmailLinkTracker,
  getEmailLinkTracker,
  trackLinksVia,
  trackableHrefs,
  EMAIL_LINKS_INTERNAL_PATH,
  EMAIL_CLICK_PATH,
  EMAIL_LINKS_MAX,
  EMAIL_LINK_MAX_LENGTH,
  LINK_TRACKER_TIMEOUT_MS,
  LINK_TRACKER_PAUSE_MS,
} from './link-tracker';
export type { EmailLinkSend, EmailLinkTracker, RemoteLinkTrackerOptions } from './link-tracker';
export type {
  SendEmailInput,
  SendEmailStrictInput,
  EmailTags,
  MailClass,
  EmailSendRecord,
  EmailSendRecorder,
} from './client';
export {
  NOTICE_MIN_INTERVAL_MS,
  THROTTLE_RETRY_DELAYS_MS,
  isThrottlingError,
  withThrottleRetry,
} from './pacing';
export type { Sleep } from './pacing';
export { createEmail } from './create-email';
export type { Email, EmailSendTags } from './create-email';
export { removeTags } from './string';
export {
  renderEmailShell,
  renderEmailSummary,
  renderEmailCallout,
  emailTheme,
  emailAccents,
  EMAIL_PREHEADER_CLASS,
  EMAIL_MUTED_CLASS,
  EMAIL_DECORATION_CLASSES,
  EMAIL_ROW_CLASS,
} from './shell';
export type { EmailShellInput, EmailAccent } from './shell';
export { default as addressparser } from 'nodemailer/lib/addressparser/index.js';
