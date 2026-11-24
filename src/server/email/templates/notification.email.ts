import { escape as escapeHtml } from 'he';
import { createEmail } from '~/server/email/templates/base.email';
import { emailTheme, simpleEmailWithTemplate } from '~/server/email/templates/util';
import { getBaseUrl } from '~/server/utils/url-helpers';

export type NotificationEmailData = {
  to: string;
  typeName: string;
  message: string;
  url?: string;
  /** The button's label; a prepared notification message can set its own (`emailButtonLabel`). */
  btnLabel?: string;
  unsubscribeUrl: string;
};

export const DEFAULT_NOTIFICATION_BUTTON_LABEL = 'View on Civitai';

export const notificationSettingsUrl = () => `${getBaseUrl()}/user/account#notification-settings`;

const subjectFor = (typeName: string) => typeName.replace(/^Services:\s*/, '');

export const absoluteUrl = (url?: string) =>
  !url ? undefined : /^https?:\/\//.test(url) ? url : `${getBaseUrl()}${url}`;

export const notificationEmail = createEmail({
  header: ({ to, typeName, unsubscribeUrl }: NotificationEmailData) => ({
    subject: subjectFor(typeName),
    to,
    headers: {
      'List-Unsubscribe': `<${unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  }),
  html: ({ typeName, message, url, btnLabel, unsubscribeUrl }: NotificationEmailData) => {
    const link = absoluteUrl(url);
    const footer = `You're getting this because email is on for
      "${escapeHtml(typeName)}". <a href="${notificationSettingsUrl()}" style="color: ${
      emailTheme.link
    };">Manage notification emails</a>
      or <a href="${escapeHtml(unsubscribeUrl)}" style="color: ${
      emailTheme.link
    };">unsubscribe from this one</a>.`;
    return simpleEmailWithTemplate({
      icon: '🔔',
      accent: 'blue',
      eyebrow: 'Notification',
      header: escapeHtml(subjectFor(typeName)),
      preheader: escapeHtml(message),
      body: `<p style="margin: 0;">${escapeHtml(message)}</p>`,
      btnUrl: link ? escapeHtml(link) : undefined,
      btnLabel: link ? escapeHtml(btnLabel ?? DEFAULT_NOTIFICATION_BUTTON_LABEL) : undefined,
      footer,
    });
  },
  text: ({ typeName, message, url, btnLabel, unsubscribeUrl }: NotificationEmailData) => {
    const link = absoluteUrl(url);
    return [
      message,
      link ? `${btnLabel ?? DEFAULT_NOTIFICATION_BUTTON_LABEL}: ${link}` : '',
      `You're getting this because email is on for "${typeName}".`,
      `Manage notification emails: ${notificationSettingsUrl()}`,
      `Unsubscribe from this one: ${unsubscribeUrl}`,
    ]
      .filter(Boolean)
      .join('\n\n');
  },
  testData: async () => ({
    to: 'test@test.com',
    typeName: 'Services: New request for your service',
    message:
      'You have a new request for "Character portrait". Accept or decline it before it expires.',
    url: '/services/deals/1',
    unsubscribeUrl: `${getBaseUrl()}/api/notifications/email-unsubscribe?u=1&t=service-deal-requested&s=x`,
  }),
});
