import { createEmail } from '~/server/email/templates/base.email';
import { simpleEmailWithTemplate } from '~/server/email/templates/util';

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
      'After reviewing your account, we have decided to keep the restriction in place. It remains active on your account.',
    positive: false,
  },
  'restriction-overturned': {
    subject: 'Civitai - Account restriction lifted',
    heading: 'Account Restriction Lifted',
    intro:
      'After reviewing your account, we have reversed the restriction. It is no longer active on your account.',
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
      'We have reviewed your appeal and approved it. The affected content and your account standing have been restored.',
    positive: true,
  },
};

const SUPPORT_LINE =
  'If you believe this was a mistake, contact our support team.';

export const moderationActionEmail = createEmail({
  header: ({ to, kind }: ModerationActionEmailData) => ({
    subject: moderationActionConfig[kind].subject,
    to,
  }),
  html({ username, kind, reason, ctaUrl }: ModerationActionEmailData) {
    const { heading, intro, positive } = moderationActionConfig[kind];

    const reasonBlock = reason
      ? `<p><strong>Reason:</strong><br/>${reason}</p>`
      : '';
    const supportLine = positive ? '' : `<p>${SUPPORT_LINE}</p>`;

    const body = `
      <p>Hi ${username},</p>
      <p>${intro}</p>
      ${reasonBlock}
      ${supportLine}
    `;

    return simpleEmailWithTemplate({
      header: heading,
      body,
      ...(positive
        ? {}
        : { btnUrl: ctaUrl ?? SUPPORT_URL, btnLabel: 'Contact Support' }),
    });
  },

  /** Plain-text fallback for clients that don't render HTML. */
  text({ username, kind, reason }: ModerationActionEmailData) {
    const { heading, intro, positive } = moderationActionConfig[kind];

    const lines = [heading, '', `Hi ${username},`, '', intro];
    if (reason) lines.push('', `Reason:`, reason);
    if (!positive) lines.push('', SUPPORT_LINE);

    return lines.join('\n') + '\n';
  },

  testData: async () => ({
    to: 'test@test.com',
    username: 'testuser',
    kind: 'account-banned' as const,
    reason: 'Repeated violations of our Terms of Service.',
  }),
});
