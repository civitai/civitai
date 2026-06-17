import { createEmail } from '~/server/email/templates/base.email';
import { SUPPORT_URL } from '~/server/email/templates/moderation/moderationAction.email';
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
      background: '#f9f9f9',
      text: '#444',
      mainBackground: '#fff',
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
      strikeReasonPublicLabel[reason as StrikeReason] ?? 'Terms of Service violation';

    return `
<body style="background: ${color.background};">
  <table width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 600px; margin: auto;">
    <tr><td height="20"></td></tr>
    <tr><td>
      <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background: ${
        color.mainBackground
      }; border-radius: 10px;">
        <tr>
          <td align="center" style="padding: 20px 0px 0px 0px;">
            <img src="${`${getBaseUrl()}/images/logo_light_mode.png`}" alt="Civitai" />
          </td>
        </tr>
        <tr>
          <td align="center"
            style="padding: 20px 20px 10px 20px; font-size: 22px; font-family: Helvetica, Arial, sans-serif; color: ${
              color.text
            };">
            <strong>Strike Notice</strong>
          </td>
        </tr>
        <tr>
          <td style="padding: 10px 20px; font-size: 16px; line-height: 24px; font-family: Helvetica, Arial, sans-serif; color: ${
            color.text
          };">
            Hi ${username},
          </td>
        </tr>
        <tr>
          <td style="padding: 10px 20px; font-size: 16px; line-height: 24px; font-family: Helvetica, Arial, sans-serif; color: ${
            color.text
          };">
            A strike has been issued on your Civitai account due to a violation of our Terms of Service.
          </td>
        </tr>
        <tr>
          <td style="padding: 10px 20px;">
            <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background: ${
              color.warningBackground
            }; border: 1px solid ${color.warningBorder}; border-radius: 8px;">
              <tr>
                <td style="padding: 15px; font-size: 14px; line-height: 22px; font-family: Helvetica, Arial, sans-serif; color: ${
                  color.text
                };">
                  <strong>Reason:</strong><br/>
                  ${reasonLabel}
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding: 10px 20px; font-size: 16px; line-height: 24px; font-family: Helvetica, Arial, sans-serif; color: ${
            color.text
          };">
            <strong>Strike Points Issued:</strong> ${points}<br/>
            <strong>Total Active Points:</strong> ${activePoints}<br/>
            <strong>Strike Expires:</strong> ${formatDate(expiresAt)}
          </td>
        </tr>
        <tr>
          <td align="center" style="padding: 20px 20px 10px 20px;">
            <table border="0" cellspacing="0" cellpadding="0">
              <tr>
                <td align="center" style="border-radius: 5px;" bgcolor="#346df1"><a href="${strikesUrl}"
                    target="_blank"
                    style="font-size: 18px; font-family: Helvetica, Arial, sans-serif; color: #fff; text-decoration: none; border-radius: 5px; padding: 12px 24px; border: 1px solid #346df1; display: inline-block; font-weight: bold;">View Your Active Strikes</a></td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding: 10px 20px; font-size: 14px; line-height: 22px; font-family: Helvetica, Arial, sans-serif; color: ${
            color.text
          };">
            <em>Please note: Accumulating additional strikes may result in temporary or permanent restrictions on your account.</em>
          </td>
        </tr>
        <tr>
          <td style="padding: 10px 20px; font-size: 14px; line-height: 22px; font-family: Helvetica, Arial, sans-serif; color: ${
            color.text
          };">
            For more information, please review our <a href="${tosUrl}" target="_blank" style="color: #346df1; text-decoration: underline;">Terms of Service</a>.
          </td>
        </tr>
        <tr>
          <td style="padding: 10px 20px; font-size: 14px; line-height: 22px; font-family: Helvetica, Arial, sans-serif; color: #666;">
            If you believe this strike was issued in error, please <a href="${SUPPORT_URL}" target="_blank" style="color: #346df1; text-decoration: underline;">contact our support team</a>.
          </td>
        </tr>
        <tr>
          <td style="padding: 10px 20px 20px 20px; font-size: 16px; line-height: 24px; font-family: Helvetica, Arial, sans-serif; color: ${
            color.text
          };">
            &mdash; ${SIGNATURE}
          </td>
        </tr>
      </table>
    </td></tr>
    <tr><td height="20"></td></tr>
  </table>
</body>
`;
  },

  text({ username, reason, points, activePoints, expiresAt }: StrikeEmailData) {
    const strikesUrl = `${getBaseUrl()}/user/account#strikes`;
    const tosUrl = `${getBaseUrl()}/content/tos`;
    const reasonLabel =
      strikeReasonPublicLabel[reason as StrikeReason] ?? 'Terms of Service violation';
    return `Strike Notice

Hi ${username},

A strike has been issued on your Civitai account due to a violation of our Terms of Service.

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
