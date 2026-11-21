import { escape as escapeHtml } from 'he';
import { createEmail } from '~/server/email/templates/base.email';
import { SUPPORT_URL } from '~/server/email/templates/moderation/moderationAction.email';
import {
  EMAIL_MUTED_CLASS,
  emailTheme,
  simpleEmailWithTemplate,
} from '~/server/email/templates/util';
import { strikeReasonPublicLabel } from '~/server/schema/strike.schema';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { StrikeReason } from '~/shared/utils/prisma/enums';

// Closing signature, kept in sync with the moderation action emails.
const SIGNATURE = 'The Civitai Moderation Team';

type StrikeEmailData = {
  to: string;
  username: string;
  reason: string;
  description: string;
  points: number;
  activePoints: number;
  expiresAt: Date;
};

const formatDate = (date: Date) =>
  date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

export const strikeIssuedEmail = createEmail({
  header: ({ to }: StrikeEmailData) => ({
    subject: 'Civitai - Strike Issued on Your Account',
    to,
  }),
  html({ username, reason, points, activePoints, expiresAt }: StrikeEmailData) {
    const color = {
      warningBackground: '#fef2f2',
      warningBorder: '#fecaca',
    };

    // Primary CTA target: the user's own account-standing view (feature-flagged
    // behind `features.strikes`). Anchored to the StrikesCard (#strikes).
    const strikesUrl = `${getBaseUrl()}/user/account#strikes`;
    const tosUrl = `${getBaseUrl()}/content/tos`;
    // Only the sanitized public label is emailed — never the mod free-text
    // `description` (kept for in-app/Retool). Fall back to a neutral label.
    const reasonLabel =
      strikeReasonPublicLabel[reason as StrikeReason] ?? 'Content violated our Terms of Service';
    const link = `color: ${emailTheme.link}; text-decoration: underline;`;
    const small = 'font-size: 14px; line-height: 22px;';

    return simpleEmailWithTemplate({
      header: 'Strike Notice',
      body: `<p style="margin: 0 0 16px 0;">Hi ${escapeHtml(username)},</p>
        <p style="margin: 0 0 16px 0;">A strike has been issued on your Civitai account.</p>
        <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" bgcolor="${
          color.warningBackground
        }" style="background-color: ${color.warningBackground}; border: 1px solid ${
        color.warningBorder
      }; border-radius: 4px;">
          <tr>
            <td style="padding: 16px; ${small} color: ${emailTheme.text};">
              <strong>Reason:</strong><br/>
              ${escapeHtml(reasonLabel)}
            </td>
          </tr>
        </table>
        <p style="margin: 16px 0 0 0;">
          <strong>Strike Points Issued:</strong> ${points}<br/>
          <strong>Total Active Points:</strong> ${activePoints}<br/>
          <strong>Strike Expires:</strong> ${formatDate(expiresAt)}
        </p>`,
      btnUrl: strikesUrl,
      btnLabel: 'View Your Active Strikes',
      afterButton: `<p style="margin: 0 0 12px 0; ${small}"><em>Please note: Accumulating additional strikes may result in temporary or permanent restrictions on your account.</em></p>
        <p style="margin: 0 0 12px 0; ${small}">For more information, please review our <a href="${tosUrl}" target="_blank" style="${link}">Terms of Service</a>.</p>
        <p class="${EMAIL_MUTED_CLASS}" style="margin: 0 0 16px 0; ${small} color: ${emailTheme.muted};">If you believe this strike was issued in error, please <a href="${SUPPORT_URL}" target="_blank" style="${link}">contact our support team</a>.</p>
        <p style="margin: 0;">&mdash; ${SIGNATURE}</p>`,
    });
  },

  text({ username, reason, points, activePoints, expiresAt }: StrikeEmailData) {
    const strikesUrl = `${getBaseUrl()}/user/account#strikes`;
    const tosUrl = `${getBaseUrl()}/content/tos`;
    const reasonLabel =
      strikeReasonPublicLabel[reason as StrikeReason] ?? 'Content violated our Terms of Service';
    return `Strike Notice

Hi ${username},

A strike has been issued on your Civitai account.

Reason:
${reasonLabel}

Strike Points Issued: ${points}
Total Active Points: ${activePoints}
Strike Expires: ${formatDate(expiresAt)}

View your active strikes and account standing:
${strikesUrl}

Please note: Accumulating additional strikes may result in temporary or permanent restrictions on your account.

For more information, please review our Terms of Service:
${tosUrl}

If you believe this strike was issued in error, please contact our support team at ${SUPPORT_URL}.

— ${SIGNATURE}
`;
  },

  testData: async () => ({
    to: 'test@test.com',
    username: 'testuser',
    reason: 'TOSViolation',
    description: 'Posting content that violates our Terms of Service.',
    points: 1,
    activePoints: 2,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  }),
});
