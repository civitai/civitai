import { randomUUID } from 'node:crypto';
import type { EmailSendTags, MailClass } from '@civitai/email';
import { sendEmail } from '~/server/email/client';
import { trackEmailLinks } from '~/server/email/link-tracking';
import { htmlToPlainText } from '~/server/email/plain-text';

/** What a template's html and text are told about the one send they render. */
export type EmailRenderContext = {
  /**
   * Lifecycle mail: the recipient's own unsubscribe link for this email type, carrying the send id.
   * The template shows it in its footer. Undefined for transactional mail.
   */
  unsubscribeUrl?: string;
};

/** One rendered send: what the transport is handed. */
export type RenderedEmail = { html: string; text: string; headers: Record<string, string> };

/** The send-time facts a render needs: the send id, and the tags the caller gave. */
export type EmailRenderInput = EmailSendTags & { sendId: string };

export function createEmail<T, T2>(email: {
  /** The template's stable key, recorded on every send (emailEvents.template). */
  template: string;
  /** `transactional` (needed or asked for) or `lifecycle` (engagement mail). */
  mailClass: MailClass;
  /**
   * Lifecycle mail only, and required for it: the email type the recipient opts out of (a
   * `UserEmailNotificationOptOut` type, LIFECYCLE_EMAIL_OPT_OUTS) and the recipient's signed
   * unsubscribe link for it. Each send's link gets its send id (`e`), goes out as the
   * List-Unsubscribe header with one-click POST, and reaches html/text as `unsubscribeUrl`.
   */
  optOut?: { type: string; url: (data: T) => string };
  /**
   * The template's links carry a single-use token (sign-in, verification, password reset, invite or
   * claim): none of its links is rewritten to the tracked click redirect, so a scanner that follows
   * a redirect never spends one. Pinned by the template ledger test.
   */
  oneTimeTokenLinks?: true;
  header: (data: T) => {
    subject: string;
    from?: string;
    to: string | string[] | null;
    cc?: string | string[] | null;
    headers?: Record<string, string>;
  };
  html: (data: T, ctx?: EmailRenderContext) => string;
  text?: (data: T, ctx?: EmailRenderContext) => string;
  // T must come from the annotated header/html params: TS 7 otherwise infers it from testData's
  // literal return, so send() demands the fixture shape. TS 5.9 resolves it correctly either
  // way, so dropping NoInfer stays green in CI. The flip side is that testData can no longer
  // supply T at all, so a template that leaves header and html unannotated gets T = unknown and
  // send() accepts anything.
  testData?: ((testDataInput: T2) => Promise<NoInfer<T>>) | (() => Promise<NoInfer<T>>);
}) {
  if (email.mailClass === 'lifecycle' && !email.optOut)
    throw new Error(`${email.template}: lifecycle mail must declare its opt-out`);

  const getHtml = (data: T, ctx?: EmailRenderContext) => email.html(data, ctx);
  // Without its own text(), an email's plain-text part is derived from the HTML. Left to the
  // transport, that was a tag strip that dropped every href, so a button's link never reached it.
  const getText = (data: T, html?: string, ctx?: EmailRenderContext) =>
    email.text ? email.text(data, ctx) : htmlToPlainText(html ?? getHtml(data, ctx));

  /** The lifecycle unsubscribe link for this send: the template's link plus the send id. */
  const unsubscribeUrlFor = (data: T, sendId: string) => {
    if (!email.optOut) return undefined;
    const url = new URL(email.optOut.url(data));
    url.searchParams.set('e', sendId);
    return url.toString();
  };

  /**
   * The message as one send goes out: links tracked (unless the template's carry one-time
   * tokens), and, for lifecycle mail, the unsubscribe link and its headers. The plain-text part is
   * rendered from the untracked HTML, so it keeps the links as they are.
   */
  const render = (data: T, input: EmailRenderInput): RenderedEmail => {
    const unsubscribeUrl = unsubscribeUrlFor(data, input.sendId);
    const ctx: EmailRenderContext = { unsubscribeUrl };
    const plainHtml = getHtml(data, ctx);
    const html = email.oneTimeTokenLinks
      ? plainHtml
      : trackEmailLinks(plainHtml, {
          sendId: input.sendId,
          template: email.template,
          mailClass: email.mailClass,
          campaign: input.campaign ?? '',
          variant: input.variant ?? '',
          userId: input.userId ?? 0,
        });
    return {
      html,
      text: getText(data, plainHtml, ctx),
      headers: {
        ...email.header(data).headers,
        ...(unsubscribeUrl
          ? {
              'List-Unsubscribe': `<${unsubscribeUrl}>`,
              'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
            }
          : {}),
      },
    };
  };

  const send = async (data: T, tags?: EmailSendTags, options?: { sendId?: string }) => {
    const sendId = options?.sendId ?? randomUUID();
    const { html, text, headers } = render(data, { ...tags, sendId });
    await sendEmail({
      ...email.header(data),
      headers,
      html,
      text,
      sendId,
      tags: { ...tags, template: email.template, mailClass: email.mailClass },
    });
  };

  return {
    template: email.template,
    mailClass: email.mailClass,
    optOutType: email.optOut?.type,
    oneTimeTokenLinks: email.oneTimeTokenLinks === true,
    send,
    render,
    getHtml,
    getText,
    getTestData: email.testData,
  };
}

export type Email = ReturnType<typeof createEmail>;
