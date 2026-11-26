import { createEmail, emailTheme, EMAIL_MUTED_CLASS, renderEmailShell } from '@civitai/email';

// Branded magic-link email. App content (lives in the app, not @civitai/email) built on the
// package's generic createEmail factory and its shared layout. Mirrors the intent of the main app's
// src/server/email/templates/emailVerification.email.ts.
type VerificationData = { to: string; url: string };

export const verificationEmail = createEmail<VerificationData, void>({
  template: 'verification',
  mailClass: 'transactional',
  // Its link is single-use: never sent to a link tracker (a scanner must not be what spends it).
  oneTimeTokenLinks: true,
  header: ({ to }) => ({ subject: 'Sign in to Civitai', to }),
  html: ({ url }) =>
    renderEmailShell({
      icon: '🔑',
      accent: 'blue',
      eyebrow: 'Your sign-in link',
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
