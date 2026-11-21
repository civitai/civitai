import { createEmail, emailTheme, EMAIL_MUTED_CLASS, renderEmailShell } from '@civitai/email';

// Branded magic-link email. App content (lives in the app, not @civitai/email) built on the
// package's generic createEmail factory and its shared layout. Mirrors the main app's
// verification.email.ts intent.
type VerificationData = { to: string; url: string };

export const verificationEmail = createEmail<VerificationData, void>({
  header: ({ to }) => ({ subject: 'Sign in to Civitai', to }),
  html: ({ url }) =>
    renderEmailShell({
      header: 'Sign in to Civitai',
      body: `<p class="${EMAIL_MUTED_CLASS}" style="margin: 0; color: ${emailTheme.muted};">
          Click the button below to sign in. This link expires in 24 hours and can be used once.
        </p>`,
      btnUrl: url,
      btnLabel: 'Sign in',
      footer: "If you didn't request this, you can safely ignore this email.",
    }),
  text: ({ url }) =>
    `Sign in to Civitai: ${url}\n\nThis link expires in 24 hours and can be used once.`,
});

export const sendVerificationEmail = (to: string, url: string) =>
  verificationEmail.send({ to, url });
