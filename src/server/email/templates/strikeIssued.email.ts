import { createEmail } from '~/server/email/templates/base.email';

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
  html({ username, description, points, activePoints, expiresAt }: StrikeEmailData) {
    const color = {
      background: '#f9f9f9',
      text: '#444',
      mainBackground: '#fff',
      warningBackground: '#fef2f2',
      warningBorder: '#fecaca',
    };

    return `
<body style="background: ${color.background};">
  <table width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 600px; margin: auto;">
    <tr><td height="20"></td></tr>
    <tr><td>
      <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background: ${
        color.mainBackground
      }; border-radius: 10px;">
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
                  <strong>Violation Details:</strong><br/>
                  ${description}
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
          <td style="padding: 10px 20px; font-size: 14px; line-height: 22px; font-family: Helvetica, Arial, sans-serif; color: ${
            color.text
          };">
            <em>Please note: Accumulating additional strikes may result in temporary or permanent restrictions on your account.</em>
          </td>
        </tr>
        <tr>
          <td style="padding: 10px 20px 20px 20px; font-size: 14px; line-height: 22px; font-family: Helvetica, Arial, sans-serif; color: #666;">
            If you believe this strike was issued in error, please contact our support team.
          </td>
        </tr>
      </table>
    </td></tr>
    <tr><td height="20"></td></tr>
  </table>
</body>
`;
  },

  text({ username, description, points, activePoints, expiresAt }: StrikeEmailData) {
    return `Strike Notice

Hi ${username},

A strike has been issued on your Civitai account due to a violation of our Terms of Service.

Violation Details:
${description}

Strike Points Issued: ${points}
Total Active Points: ${activePoints}
Strike Expires: ${formatDate(expiresAt)}

Please note: Accumulating additional strikes may result in temporary or permanent restrictions on your account.

If you believe this strike was issued in error, please contact our support team.
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
