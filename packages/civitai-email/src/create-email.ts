// Generic template factory — the same API as the app's templates/base.email.ts. Templates
// themselves (branded copy) stay in each app; this just standardizes how they bind to the
// transport. Every template names its key and mail class, which tag each of its sends.
import {
  emailSendRecord,
  isEmailConfigured,
  resolveSendId,
  sendEmail,
  type EmailTags,
  type MailClass,
} from './client';
import { getEmailLinkTracker, trackLinksVia } from './link-tracker';

/** Per-send tags a template's caller may add: the recipient's user id, a campaign, a variant. */
export type EmailSendTags = Omit<EmailTags, 'template' | 'mailClass'>;

export function createEmail<T, T2>(email: {
  /** The template's stable key, recorded on every send. */
  template: string;
  mailClass: MailClass;
  /**
   * The template's links carry a single-use token (sign-in, verification, reset, invite): none of
   * them is ever sent to the link tracker, so a scanner that follows a redirect never spends one.
   */
  oneTimeTokenLinks?: true;
  header: (data: T) => { subject: string; from?: string; to: string | string[] | null };
  html: (data: T) => string;
  text?: (data: T) => string;
  testData?: ((testDataInput: T2) => Promise<T>) | (() => Promise<T>);
}) {
  const templateTags = { template: email.template, mailClass: email.mailClass };

  /**
   * The HTML one send goes out with: its links put through the app's link tracker
   * (setEmailLinkTracker), when one is registered and the template's links carry no one-time
   * token. Without a tracker, or when it fails, the links are as the template wrote them.
   */
  const getTrackedHtml = async (data: T, sendId: string, tags?: EmailSendTags) => {
    const html = email.html(data);
    const tracker = getEmailLinkTracker();
    if (!tracker || email.oneTimeTokenLinks) return html;
    return trackLinksVia(tracker, html, {
      sendId,
      template: email.template,
      mailClass: email.mailClass,
      campaign: tags?.campaign ?? '',
      variant: tags?.variant ?? '',
      // The send row's rule (emailSendRecord): an id outside a UInt32 is unknown.
      userId: emailSendRecord(sendId, { ...tags, ...templateTags }, new Date()).userId,
    });
  };

  const send = async (data: T, tags?: EmailSendTags) => {
    // Minted here so the tracked links and the send row carry the same send id.
    const sendId = resolveSendId(undefined);
    const header = email.header(data);
    // A message that will not go out (no recipient, or no transport) never calls the tracker.
    const html =
      header.to && isEmailConfigured()
        ? await getTrackedHtml(data, sendId, tags)
        : email.html(data);
    await sendEmail({
      ...header,
      html,
      text: email.text?.(data),
      sendId,
      tags: { ...tags, ...templateTags },
    });
  };

  const getHtml = (data: T) => email.html(data);

  return {
    template: email.template,
    mailClass: email.mailClass,
    oneTimeTokenLinks: email.oneTimeTokenLinks === true,
    send,
    getHtml,
    getTrackedHtml,
    getTestData: email.testData,
  };
}

export type Email = ReturnType<typeof createEmail>;
