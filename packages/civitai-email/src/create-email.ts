// Generic template factory — the same API as the app's templates/base.email.ts. Templates
// themselves (branded copy) stay in each app; this just standardizes how they bind to the
// transport. Every template names its key and mail class, which tag each of its sends.
import { sendEmail, type EmailTags, type MailClass } from './client';

/** Per-send tags a template's caller may add: the recipient's user id, a campaign, a variant. */
export type EmailSendTags = Omit<EmailTags, 'template' | 'mailClass'>;

export function createEmail<T, T2>(email: {
  /** The template's stable key, recorded on every send. */
  template: string;
  mailClass: MailClass;
  header: (data: T) => { subject: string; from?: string; to: string | string[] | null };
  html: (data: T) => string;
  text?: (data: T) => string;
  testData?: ((testDataInput: T2) => Promise<T>) | (() => Promise<T>);
}) {
  const send = async (data: T, tags?: EmailSendTags) => {
    await sendEmail({
      ...email.header(data),
      html: email.html(data),
      text: email.text?.(data),
      tags: { ...tags, template: email.template, mailClass: email.mailClass },
    });
  };

  const getHtml = (data: T) => email.html(data);

  return {
    template: email.template,
    mailClass: email.mailClass,
    send,
    getHtml,
    getTestData: email.testData,
  };
}

export type Email = ReturnType<typeof createEmail>;
