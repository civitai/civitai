import { escape as escapeHtml } from 'he';
import { createEmail } from '~/server/email/templates/base.email';
import { absoluteUrl, notificationSettingsUrl } from '~/server/email/templates/notification.email';
import { emailTheme, simpleEmailWithTemplate } from '~/server/email/templates/util';
import { MISSED_DIGEST_DISPLAY_NAME } from '~/server/notifications/missed-digest.constants';
import { getBaseUrl } from '~/server/utils/url-helpers';

export type MissedNotificationsDigestItem = { message: string; url?: string };

export type MissedNotificationsDigestData = {
  to: string;
  /** The newest unseen notifications, newest first, already capped. */
  items: MissedNotificationsDigestItem[];
  /** Unseen notifications in the window, including the listed ones. */
  total: number;
  /** True when `total` stopped at its ceiling, so the real number may be higher. */
  totalIsFloor: boolean;
  unsubscribeUrl: string;
};

export const notificationsPageUrl = () => `${getBaseUrl()}/user/notifications`;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const countLabel = ({ total, totalIsFloor }: MissedNotificationsDigestData) =>
  totalIsFloor ? `${total}+ notifications` : plural(total, 'notification');

const subjectFor = (data: MissedNotificationsDigestData) =>
  `You have ${countLabel(data)} you haven't seen`;

/** "and N more", or nothing when every unseen notification is listed. */
const moreLine = (data: MissedNotificationsDigestData) => {
  const more = data.total - data.items.length;
  if (more <= 0 && !data.totalIsFloor) return undefined;
  return data.totalIsFloor ? `and ${Math.max(more, 0)}+ more` : `and ${more} more`;
};

export const missedNotificationsDigestEmail = createEmail({
  header: (data: MissedNotificationsDigestData) => ({
    subject: subjectFor(data),
    to: data.to,
    headers: {
      'List-Unsubscribe': `<${data.unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  }),
  html: (data: MissedNotificationsDigestData) => {
    const list = data.items
      .map(({ message, url }) => {
        const link = absoluteUrl(url);
        const text = escapeHtml(message);
        return `<li style="margin-bottom: 8px;">${
          link
            ? `<a href="${escapeHtml(link)}" style="color: ${emailTheme.link};">${text}</a>`
            : text
        }</li>`;
      })
      .join('');
    const more = moreLine(data);
    const footer = `You're getting this because
      "${escapeHtml(
        MISSED_DIGEST_DISPLAY_NAME
      )}" is on. <a href="${notificationSettingsUrl()}" style="color: ${
      emailTheme.link
    };">Manage notification emails</a>
      or <a href="${escapeHtml(data.unsubscribeUrl)}" style="color: ${
      emailTheme.link
    };">unsubscribe from this one</a>.`;
    return simpleEmailWithTemplate({
      header: escapeHtml(`Notifications you missed this week`),
      body: `<p>${escapeHtml(
        `You have ${countLabel(data)} on Civitai you haven't seen.`
      )}</p><ul style="text-align: left; padding-left: 20px;">${list}</ul>${
        more ? `<p>${escapeHtml(more)}</p>` : ''
      }`,
      btnUrl: escapeHtml(notificationsPageUrl()),
      btnLabel: 'See all notifications',
      footer,
    });
  },
  text: (data: MissedNotificationsDigestData) => {
    const more = moreLine(data);
    return [
      `You have ${countLabel(data)} on Civitai you haven't seen.`,
      data.items
        .map(({ message, url }) => {
          const link = absoluteUrl(url);
          return link ? `- ${message}\n  ${link}` : `- ${message}`;
        })
        .join('\n'),
      more ?? '',
      `See all notifications: ${notificationsPageUrl()}`,
      `You're getting this because "${MISSED_DIGEST_DISPLAY_NAME}" is on.`,
      `Manage notification emails: ${notificationSettingsUrl()}`,
      `Unsubscribe from this one: ${data.unsubscribeUrl}`,
    ]
      .filter(Boolean)
      .join('\n\n');
  },
  testData: async () => ({
    to: 'test@test.com',
    items: [
      { message: 'Someone replied to your comment.', url: '/models/1' },
      { message: 'Your image got 10 reactions.', url: '/images/1' },
    ],
    total: 14,
    totalIsFloor: false,
    unsubscribeUrl: `${getBaseUrl()}/api/notifications/email-unsubscribe?u=1&t=missed-notification-digest&s=x`,
  }),
});
