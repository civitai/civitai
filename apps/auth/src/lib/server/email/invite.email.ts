import {
  createEmail,
  emailTheme,
  EMAIL_MUTED_CLASS,
  renderEmailCallout,
  renderEmailShell,
} from '@civitai/email';
import { escapeHtml } from '@civitai/shared/html-escape';

// appName comes from the client's registration, never the request, so an app can't send invites in
// another's name.
type InviteData = {
  to: string;
  url: string;
  appName: string;
  invitedBy: string | null;
  message: string | null;
};

const headline = ({ appName, invitedBy }: InviteData) =>
  invitedBy ? `${invitedBy} invited you to ${appName}` : `You're invited to ${appName}`;

export const inviteEmail = createEmail<InviteData, void>({
  header: (data) => ({ subject: headline(data), to: data.to }),
  html: (data) =>
    renderEmailShell({
      icon: '💌',
      accent: 'violet',
      eyebrow: 'Invitation',
      header: escapeHtml(headline(data)),
      body: `${
        data.message ? renderEmailCallout(escapeHtml(data.message), { accent: 'violet' }) : ''
      }<p class="${EMAIL_MUTED_CLASS}" style="margin: 0; color: ${emailTheme.muted};">
          Accept to sign in to Civitai with this email address. If you don't have an account yet, one is
          created for you. This link expires in 7 days and can be used once.
        </p>`,
      btnUrl: data.url,
      btnLabel: 'Accept invite',
      footer: "If you weren't expecting this, you can safely ignore this email.",
    }),
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
