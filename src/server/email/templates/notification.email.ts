import { escape as escapeHtml } from 'he';
import { createEmail } from '~/server/email/templates/base.email';
import { simpleEmailWithTemplate } from '~/server/email/templates/util';
import { getBaseUrl } from '~/server/utils/url-helpers';

export type NotificationEmailData = {
  to: string;
  /** The notification type's display name, as the settings page lists it. */
  typeName: string;
  message: string;
  url?: string;
  /** One-click unsubscribe from this type (RFC 8058). */
  unsubscribeUrl: string;
};

export const notificationSettingsUrl = () => `${getBaseUrl()}/user/account#notification-settings`;

const subjectFor = (typeName: string) => typeName.replace(/^Services:\s*/, '');

const absoluteUrl = (url?: string) =>
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
  html: ({ typeName, message, url, unsubscribeUrl }: NotificationEmailData) => {
    const link = absoluteUrl(url);
    const footer = `<p style="font-size: 13px; color: #888;">You're getting this because email is on for
      "${escapeHtml(
        typeName
      )}". <a href="${notificationSettingsUrl()}">Manage notification emails</a>
      or <a href="${escapeHtml(unsubscribeUrl)}">unsubscribe from this one</a>.</p>`;
    return simpleEmailWithTemplate({
      header: escapeHtml(subjectFor(typeName)),
      body: `<p>${escapeHtml(message)}</p>${footer}`,
      btnUrl: link ? escapeHtml(link) : undefined,
      btnLabel: link ? 'View on Civitai' : undefined,
    });
  },
  text: ({ typeName, message, url, unsubscribeUrl }: NotificationEmailData) => {
    const link = absoluteUrl(url);
    return [
      message,
      link ? `View on Civitai: ${link}` : '',
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
