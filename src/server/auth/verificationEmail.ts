import { Theme } from 'next-auth';
import { SendVerificationRequestParams } from 'next-auth/providers';
import { createTransport } from 'nodemailer';

export async function sendVerificationRequest({
  identifier: to,
  url,
  provider: { server, from },
  theme,
}: SendVerificationRequestParams) {
  // NOTE: You are not required to use `nodemailer`, use whatever you want.
  const transport = createTransport(server);
  const result = await transport.sendMail({
    to,
    from,
    subject: `Sign in to Civitai`,
    text: text({ url }),
    html: html({ url, theme }),
  });
  const failed = result.rejected.concat(result.pending).filter(Boolean);
  if (failed.length) {
    throw new Error(`Email(s) (${failed.join(', ')}) could not be sent`);
  }
}

/**
 * Email HTML body
 * Insert invisible space into domains from being turned into a hyperlink by email
 * clients like Outlook and Apple mail, as this is confusing because it seems
 * like they are supposed to click on it to sign in.
 *
 * @note We don't add the email address to avoid needing to escape it, if you do, remember to sanitize it!
 */
function html({ url, theme }: { url: string; theme: Theme }) {
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
}

/** Email Text body (fallback for email clients that don't render HTML, e.g. feature phones) */
function text({ url }: { url: string }) {
  return `Sign in to Civitai:\n${url}\n\n`;
}
