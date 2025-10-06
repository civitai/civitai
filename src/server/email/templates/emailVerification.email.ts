import { createEmail } from '~/server/email/templates/base.email';
import { getBaseUrl } from '~/server/utils/url-helpers';

type EmailVerificationData = {
  to: string;
  username: string;
  verificationUrl: string;
};

export const emailVerificationEmail = createEmail({
  header: ({ to }: EmailVerificationData) => ({
    subject: 'Verify your new email address - Civitai',
    to,
  }),

  html({ username, verificationUrl }: EmailVerificationData) {
    const brandColor = '#346df1';

    const color = {
      background: '#f9f9f9',
      text: '#444',
      mainBackground: '#fff',
      buttonBackground: brandColor,
      buttonBorder: brandColor,
      buttonText: '#fff',
      muted: '#6b7280',
    };

    return `
    <body style="background: ${color.background};">
      <table width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 600px; margin: auto;">
        <tr><td height="20"></td></tr>
        <tr><td>
          <table width="100%" border="0" cellspacing="20" cellpadding="0" style="background: ${color.mainBackground}; border-radius: 10px;">
            <tr>
              <td align="center" style="padding: 20px 0px; font-size: 24px; font-family: Helvetica, Arial, sans-serif; color: ${color.text};">
                <strong>Email Address Verification</strong>
              </td>
            </tr>
            <tr>
              <td style="padding: 0px 20px; font-size: 16px; line-height: 22px; font-family: Helvetica, Arial, sans-serif; color: ${color.text};">
                Hi <strong>${username}</strong>,
              </td>
            </tr>
            <tr>
              <td style="padding: 0px 20px; font-size: 16px; line-height: 22px; font-family: Helvetica, Arial, sans-serif; color: ${color.text};">
                You requested to change your email address on Civitai. Please click the button below to verify your new email address:
              </td>
            </tr>
            <tr>
              <td align="center" style="padding: 20px;">
                <table border="0" cellspacing="0" cellpadding="0">
                  <tr>
                    <td align="center" style="border-radius: 6px;" bgcolor="${color.buttonBackground}">
                      <a href="${verificationUrl}" target="_blank"
                         style="font-size: 16px; font-family: Helvetica, Arial, sans-serif; color: ${color.buttonText}; text-decoration: none; border-radius: 6px; padding: 12px 24px; border: 1px solid ${color.buttonBorder}; display: inline-block; font-weight: bold;">
                        Verify Email Address
                      </a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding: 0px 20px; font-size: 14px; line-height: 20px; font-family: Helvetica, Arial, sans-serif; color: ${color.text};">
                If the button doesn't work, you can copy and paste this link into your browser:
              </td>
            </tr>
            <tr>
              <td style="padding: 0px 20px; font-size: 14px; line-height: 20px; font-family: Helvetica, Arial, sans-serif; color: ${color.muted}; word-break: break-all;">
                ${verificationUrl}
              </td>
            </tr>
            <tr>
              <td style="padding: 20px 20px 10px 20px; font-size: 14px; line-height: 20px; font-family: Helvetica, Arial, sans-serif; color: ${color.muted};">
                This verification link will expire in 15 minutes. If you didn't request this change, please ignore this email.
              </td>
            </tr>
          </table>
        </td></tr>
        <tr>
          <td style="padding: 10px 20px; font-size: 12px; line-height: 16px; font-family: Helvetica, Arial, sans-serif; color: ${color.muted}; text-align: center;">
            This email was sent from Civitai. If you have any questions, please contact our support team.
          </td>
        </tr>
        <tr><td height="20"></td></tr>
      </table>
    </body>
    `;
  },

  text({ username, verificationUrl }: EmailVerificationData) {
    return `Hi ${username},

You requested to change your email address on Civitai. Please visit the following link to verify your new email address:

${verificationUrl}

This verification link will expire in 15 minutes. If you didn't request this change, please ignore this email.

---
Civitai Team
`;
  },

  testData: async () => ({
    to: 'test@example.com',
    username: 'TestUser',
    verificationUrl: `${getBaseUrl()}/verify-email?token=test-token`,
  }),
});
