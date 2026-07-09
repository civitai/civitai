import { escape as escapeHtml } from 'he';
import { createEmail } from '~/server/email/templates/base.email';
import { simpleEmailWithTemplate } from '~/server/email/templates/util';
import { getBaseUrl } from '~/server/utils/url-helpers';

export type ModerationActionKind =
  | 'account-banned'
  | 'account-unbanned'
  | 'restriction-upheld'
  | 'restriction-overturned'
  | 'appeal-rejected'
  | 'appeal-approved';

export type ModerationActionEmailData = {
  to: string | null;
  username: string;
  kind: ModerationActionKind;
  reason?: string; // brief explanation; rendered only when present
  ctaUrl?: string; // optional override; negative kinds default to the support site
  // Affected content (used by appeal kinds): rendered as a list after the intro,
  // each linked when a public `url` is available. `label` is always shown.
  items?: { url?: string; label: string }[];
};

export const SUPPORT_URL = 'https://support.civitai.com';

type ModerationActionConfig = {
  subject: string;
  heading: string;
  intro: string;
  positive: boolean;
};

// Single source of truth for per-kind copy, read by both header() and html()/text().
export const moderationActionConfig: Record<ModerationActionKind, ModerationActionConfig> = {
  'account-banned': {
    subject: 'Civitai - Your account has been banned',
    heading: 'Account Banned',
    intro:
      'Your Civitai account has been banned. This means you no longer have access to your account or its content.',
    positive: false,
  },
  'account-unbanned': {
    subject: 'Civitai - Your account has been reinstated',
    heading: 'Account Reinstated',
    intro:
      'Your Civitai account has been reinstated. Full access to your account and content has been restored.',
    positive: true,
  },
  'restriction-upheld': {
    subject: 'Civitai - Account restriction upheld',
    heading: 'Account Restriction Upheld',
    intro:
      'After reviewing your account, we have decided to keep the restriction that was applied to it in place. The restriction is still active.',
    positive: false,
  },
  'restriction-overturned': {
    subject: 'Civitai - Account restriction lifted',
    heading: 'Account Restriction Lifted',
    intro:
      'After reviewing your account, we have removed the restriction that was applied to it. Your account is in good standing and you can use it normally again.',
    positive: true,
  },
  'appeal-rejected': {
    subject: 'Civitai - Appeal decision',
    heading: 'Appeal Decision',
    intro:
      'We have reviewed your appeal. After careful consideration, the original moderation decision stands.',
    positive: false,
  },
  'appeal-approved': {
    subject: 'Civitai - Appeal approved',
    heading: 'Appeal Approved',
    intro:
      'We have reviewed your appeal and approved it. Any affected content and your account standing have been restored.',
    positive: true,
  },
};

const SUPPORT_LINE =
  'If you believe this was a mistake, contact our support team.';

// Closing signature appended to every moderation email.
const SIGNATURE = 'The Civitai Moderation Team';

// Lead-in line shown above the affected-content list.
const itemsLeadIn = (positive: boolean) =>
  positive ? 'This applies to the following:' : 'This decision applies to the following:';

export const moderationActionEmail = createEmail({
  header: ({ to, kind }: ModerationActionEmailData) => ({
    subject: moderationActionConfig[kind].subject,
    to,
  }),
  html({ username, kind, reason, ctaUrl, items }: ModerationActionEmailData) {
    const { heading, intro, positive } = moderationActionConfig[kind];

    // Escape user/moderator-supplied text before interpolating into HTML —
    // prevents markup injection and stray characters (e.g. `<`, `&`) from
    // breaking email rendering. `intro`/`heading` are static config, no escape.
    // Positive outcomes (reinstated / overturned / approved) are good news and
    // never carry a reason — suppress the block even if a caller passes one.
    const reasonBlock =
      !positive && reason
        ? `<p><strong>Reason:</strong><br/>${escapeHtml(reason)}</p>`
        : '';
    // Negative outcomes link to the Terms of Service for a non-explicit policy
    // reference (positive outcomes are good news and get no policy link).
    const tosBlock = !positive
      ? `<p>For more information, please review our <a href="${getBaseUrl()}/content/tos">Terms of Service</a>.</p>`
      : '';
    const supportLine = positive ? '' : `<p>${SUPPORT_LINE}</p>`;

    // Affected-content list. Each label/url is user-adjacent data, so escape both.
    const itemsBlock =
      items && items.length
        ? `<p>${itemsLeadIn(positive)}</p><ul>${items
            .map(
              ({ url, label }) =>
                `<li>${
                  url ? `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>` : escapeHtml(label)
                }</li>`
            )
            .join('')}</ul>`
        : '';

    const body = `
      <p>Hi ${escapeHtml(username)},</p>
      <p>${intro}</p>
      ${itemsBlock}
      ${reasonBlock}
      ${tosBlock}
      ${supportLine}
      <p>&mdash; ${SIGNATURE}</p>
    `;

    return simpleEmailWithTemplate({
      header: heading,
      body,
      ...(positive
        ? {}
        : { btnUrl: escapeHtml(ctaUrl ?? SUPPORT_URL), btnLabel: 'Contact Support' }),
    });
  },

  /** Plain-text fallback for clients that don't render HTML. */
  text({ username, kind, reason, items }: ModerationActionEmailData) {
    const { heading, intro, positive } = moderationActionConfig[kind];

    const lines = [heading, '', `Hi ${username},`, '', intro];
    if (items?.length) {
      lines.push('', itemsLeadIn(positive));
      for (const { url, label } of items) lines.push(url ? `- ${label}: ${url}` : `- ${label}`);
    }
    if (!positive && reason) lines.push('', `Reason:`, reason);
    if (!positive)
      lines.push('', `For more information, review our Terms of Service: ${getBaseUrl()}/content/tos`);
    if (!positive) lines.push('', SUPPORT_LINE);
    lines.push('', `— ${SIGNATURE}`);

    return lines.join('\n') + '\n';
  },

  // Debug-only (email previewer at /api/testing/email/[template]). Reads query
  // params so every kind can be previewed: ?kind=appeal-approved&reason=...&username=...
  // Debug-only data for the previewer. A reason is always supplied; the template
  // itself decides whether to render it (positive kinds never show one). Appeal
  // kinds get sample linked items so the affected-content list is previewable.
  testData: async (
    input: Partial<ModerationActionEmailData> = {}
  ): Promise<ModerationActionEmailData> => {
    const kind = (input.kind as ModerationActionKind) ?? 'account-banned';
    const isAppeal = kind === 'appeal-approved' || kind === 'appeal-rejected';
    return {
      to: 'test@test.com',
      username: input.username ?? 'testuser',
      kind,
      reason: input.reason ?? 'Repeated violations of our Terms of Service.',
      ctaUrl: input.ctaUrl,
      items: isAppeal
        ? [
            { url: 'https://civitai.com/images/12345', label: 'Image #12345' },
            { url: 'https://civitai.com/images/12346', label: 'Image #12346' },
          ]
        : undefined,
    };
  },
});
