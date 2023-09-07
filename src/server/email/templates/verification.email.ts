import { Theme } from 'next-auth';
import { createEmail } from '~/server/email/templates/base.email';
import { getBaseUrl } from '~/server/utils/url-helpers';

type VerificationEmailData = {
  to: string;
  url: string;
  theme: Theme;
};

export const verificationEmail = createEmail({
  header: ({ to }: VerificationEmailData) => ({
    subject: `Sign in to Civitai`,
    to,
  }),
  html({ url, theme }: VerificationEmailData) {
    const brandColor = theme.brandColor || '#346df1';
    const color = {
      background: '#f9f9f9',
      text: '#444',
      mainBackground: '#fff',
      buttonBackground: brandColor,
      buttonBorder: brandColor,
      buttonText: theme.buttonText || '#fff',
    };

    return `
  <body style="background: ${color.background};">
    <table width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 600px; margin: auto;">
      <tr><td height="20"></td></tr>
      <tr><td>
        <table width="100%" border="0" cellspacing="20" cellpadding="0" style="background: ${color.mainBackground}; border-radius: 10px;">
          <tr>
            <td align="center"
              style="padding: 10px 0px; font-size: 22px; font-family: Helvetica, Arial, sans-serif; color: ${color.text};">
              Sign in to <strong>Civitai</strong>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding: 0;">
              <table border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td align="center" style="border-radius: 5px;" bgcolor="${color.buttonBackground}"><a href="${url}"
                      target="_blank"
                      style="font-size: 18px; font-family: Helvetica, Arial, sans-serif; color: ${color.buttonText}; text-decoration: none; border-radius: 5px; padding: 10px 20px; border: 1px solid ${color.buttonBorder}; display: inline-block; font-weight: bold;">Sign
                      in</a></td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center"
              style="padding: 0px 0px 10px 0px; font-size: 16px; line-height: 22px; font-family: Helvetica, Arial, sans-serif; color: ${color.text};">
              If you did not request this email you can safely ignore it.
            </td>
          </tr>
        </table>
      </td></tr>
      <tr><td height="20"></td></tr>
    </table>
  </body>
  `;
  },

  text({ url }: VerificationEmailData) {
    return `Sign in to Civitai:\n${url}\n\n`;
  },

  testData: async () => ({
    to: 'test@tester.com',
    url: getBaseUrl(),
    theme: {} as Theme,
  }),
});
