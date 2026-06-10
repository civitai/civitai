import { createEmail } from '@civitai/email';

// Branded magic-link email. App content (lives in the app, not @civitai/email) built on the
// package's generic createEmail factory. Mirrors the main app's verification.email.ts intent.
type VerificationData = { to: string; url: string };

const brandColor = '#2563eb';

export const verificationEmail = createEmail<VerificationData, void>({
  header: ({ to }) => ({ subject: 'Sign in to Civitai', to }),
  html: ({ url }) => `
  <body style="background:#f6f7f9;margin:0;padding:24px;font-family:system-ui,sans-serif;">
    <table align="center" width="100%" style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;">
      <tr><td style="text-align:center;">
        <h1 style="font-size:20px;margin:0 0 8px;color:#16181d;">Sign in to Civitai</h1>
        <p style="font-size:14px;color:#5f6368;margin:0 0 24px;">
          Click the button below to sign in. This link expires in 24 hours and can be used once.
        </p>
        <a href="${url}" style="display:inline-block;background:${brandColor};color:#fff;text-decoration:none;font-weight:600;padding:12px 24px;border-radius:8px;">
          Sign in
        </a>
        <p style="font-size:12px;color:#9aa0a6;margin:24px 0 0;">
          If you didn't request this, you can safely ignore this email.
        </p>
      </td></tr>
    </table>
  </body>`,
  text: ({ url }) =>
    `Sign in to Civitai: ${url}\n\nThis link expires in 24 hours and can be used once.`,
});

export const sendVerificationEmail = (to: string, url: string) =>
  verificationEmail.send({ to, url });
