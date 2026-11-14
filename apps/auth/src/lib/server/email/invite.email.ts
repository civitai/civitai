import { createEmail } from '@civitai/email';

// appName comes from the client's registration, never the request, so an app can't send invites in
// another's name.
type InviteData = {
  to: string;
  url: string;
  appName: string;
  invitedBy: string | null;
  message: string | null;
};

const brandColor = '#2563eb';

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)
  );

const headline = ({ appName, invitedBy }: InviteData) =>
  invitedBy ? `${invitedBy} invited you to ${appName}` : `You're invited to ${appName}`;

export const inviteEmail = createEmail<InviteData, void>({
  header: (data) => ({ subject: headline(data), to: data.to }),
  html: (data) => `
  <body style="background:#f6f7f9;margin:0;padding:24px;font-family:system-ui,sans-serif;">
    <table align="center" width="100%" style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;">
      <tr><td style="text-align:center;">
        <h1 style="font-size:20px;margin:0 0 8px;color:#16181d;">${escapeHtml(headline(data))}</h1>
        ${
          data.message
            ? `<p style="font-size:14px;color:#16181d;margin:0 0 16px;">${escapeHtml(
                data.message
              )}</p>`
            : ''
        }
        <p style="font-size:14px;color:#5f6368;margin:0 0 24px;">
          Accept to sign in to Civitai with this email address. If you don't have an account yet, one is
          created for you. This link expires in 7 days and can be used once.
        </p>
        <a href="${
          data.url
        }" style="display:inline-block;background:${brandColor};color:#fff;text-decoration:none;font-weight:600;padding:12px 24px;border-radius:8px;">
          Accept invite
        </a>
        <p style="font-size:12px;color:#9aa0a6;margin:24px 0 0;">
          If you weren't expecting this, you can safely ignore this email.
        </p>
      </td></tr>
    </table>
  </body>`,
  text: (data) =>
    [
      headline(data),
      data.message,
      `Accept the invite: ${data.url}`,
      `This link expires in 7 days and can be used once. If you weren't expecting this, you can ignore this email.`,
    ]
      .filter(Boolean)
      .join('\n\n'),
});
