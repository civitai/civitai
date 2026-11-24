import type { EmailSendTags, MailClass } from '@civitai/email';
import { sendEmail } from '~/server/email/client';
import { htmlToPlainText } from '~/server/email/plain-text';
export function createEmail<T, T2>(email: {
  /** The template's stable key, recorded on every send (emailEvents.template). */
  template: string;
  /** `transactional` (needed or asked for) or `lifecycle` (engagement mail). */
  mailClass: MailClass;
  header: (data: T) => {
    subject: string;
    from?: string;
    to: string | string[] | null;
    cc?: string | string[] | null;
    headers?: Record<string, string>;
  };
  html: (data: T) => string;
  text?: (data: T) => string;
  // T must come from the annotated header/html params: TS 7 otherwise infers it from testData's
  // literal return, so send() demands the fixture shape. TS 5.9 resolves it correctly either
  // way, so dropping NoInfer stays green in CI. The flip side is that testData can no longer
  // supply T at all, so a template that leaves header and html unannotated gets T = unknown and
  // send() accepts anything.
  testData?: ((testDataInput: T2) => Promise<NoInfer<T>>) | (() => Promise<NoInfer<T>>);
}) {
  const getHtml = (data: T) => email.html(data);
  // Without its own text(), an email's plain-text part is derived from the HTML. Left to the
  // transport, that was a tag strip that dropped every href, so a button's link never reached it.
  const getText = (data: T, html?: string) =>
    email.text ? email.text(data) : htmlToPlainText(html ?? getHtml(data));

  // `tags` adds what the caller knows about this one send: the user id, a campaign, a variant.
  const send = async (data: T, tags?: EmailSendTags) => {
    const html = getHtml(data);
    await sendEmail({
      ...email.header(data),
      html,
      text: getText(data, html),
      tags: { ...tags, template: email.template, mailClass: email.mailClass },
    });
  };

  return {
    template: email.template,
    mailClass: email.mailClass,
    send,
    getHtml,
    getText,
    getTestData: email.testData,
  };
}

export type Email = ReturnType<typeof createEmail>;
