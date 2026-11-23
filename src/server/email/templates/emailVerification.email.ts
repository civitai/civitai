import { escape as escapeHtml } from 'he';
import { createEmail } from '~/server/email/templates/base.email';
import {
  EMAIL_MUTED_CLASS,
  emailTheme,
  simpleEmailWithTemplate,
} from '~/server/email/templates/util';
import { getBaseUrl } from '~/server/utils/url-helpers';

type EmailVerificationData = {
  to: string;
  username: string;
  verificationUrl: string;
  isEmailChange: boolean;
};

export const emailVerificationEmail = createEmail({
  header: ({ to, isEmailChange }: EmailVerificationData) => ({
    subject: isEmailChange
      ? 'Verify your new email address - Civitai'
      : 'Verify your email address - Civitai',
    to,
  }),

  html({ username, verificationUrl, isEmailChange }: EmailVerificationData) {
    const url = escapeHtml(verificationUrl);
    const small = `font-size: 14px; line-height: 20px;`;
    return simpleEmailWithTemplate({
      icon: '✉️',
      accent: 'blue',
      eyebrow: isEmailChange ? 'Confirm your new email' : 'Confirm your email',
      header: 'Email Address Verification',
      body: `<p style="margin: 0 0 16px 0;">Hi <strong>${escapeHtml(username)}</strong>,</p>
        <p style="margin: 0;">${
          isEmailChange
            ? 'You requested to change your email address on Civitai. Please click the button below to verify your new email address:'
            : 'Please click the button below to verify your email address on Civitai:'
        }</p>`,
      btnUrl: url,
      btnLabel: 'Verify Email Address',
      afterButton: `<p style="margin: 0; ${small}">If the button doesn't work, you can copy and paste this link into your browser:</p>
        <p class="${EMAIL_MUTED_CLASS}" style="margin: 0 0 16px 0; ${small} color: ${emailTheme.muted}; word-break: break-all;">${url}</p>
        <p class="${EMAIL_MUTED_CLASS}" style="margin: 0; ${small} color: ${emailTheme.muted};">This verification link will expire in 15 minutes. If you didn't request this, please ignore this email.</p>`,
      footer:
        'This email was sent from Civitai. If you have any questions, please contact our support team.',
    });
  },

  text({ username, verificationUrl, isEmailChange }: EmailVerificationData) {
    return `Hi ${username},

${
  isEmailChange
    ? 'You requested to change your email address on Civitai. Please visit the following link to verify your new email address:'
    : 'Please visit the following link to verify your email address on Civitai:'
}

${verificationUrl}

This verification link will expire in 15 minutes. If you didn't request this, please ignore this email.

---
Civitai Team
`;
  },

  testData: async () => ({
    to: 'test@example.com',
    username: 'TestUser',
    verificationUrl: `${getBaseUrl()}/verify-email?token=test-token`,
    isEmailChange: false,
  }),
});
