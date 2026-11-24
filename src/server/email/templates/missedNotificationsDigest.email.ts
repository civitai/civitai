import { escape as escapeHtml } from 'he';
import { createEmail, type EmailRenderContext } from '~/server/email/templates/base.email';
import { absoluteUrl, notificationSettingsUrl } from '~/server/email/templates/notification.email';
import { emailTheme, simpleEmailWithTemplate } from '~/server/email/templates/util';
import {
  MISSED_DIGEST_DISPLAY_NAME,
  MISSED_DIGEST_EMAIL_TYPE,
} from '~/server/notifications/missed-digest.constants';
import { getBaseUrl } from '~/server/utils/url-helpers';

/** Where the digest's rewritten (non-item) links start counting: above any item position. */
export const DIGEST_REWRITTEN_LINKS_FROM = 101;

export type MissedNotificationsDigestItem = { message: string; url?: string };

export type MissedNotificationsDigestData = {
  to: string;
  /** The newest unseen notifications, newest first, already capped. */
  items: MissedNotificationsDigestItem[];
  /** Unseen notifications in the window, including the listed ones. */
  total: number;
  /** True when `total` stopped at its ceiling, so the real number may be higher. */
  totalIsFloor: boolean;
  /** The recipient's signed unsubscribe link; each send adds its send id (base.email.ts). */
  unsubscribeUrl: string;
  /** The "See all notifications" link; the notifications page when not given. */
  allUrl?: string;
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
  template: 'missedNotificationsDigest',
  mailClass: 'lifecycle',
  // createEmail sets List-Unsubscribe and List-Unsubscribe-Post from this link.
  optOut: {
    type: MISSED_DIGEST_EMAIL_TYPE,
    url: (data: MissedNotificationsDigestData) => data.unsubscribeUrl,
  },
  header: (data: MissedNotificationsDigestData) => ({
    subject: subjectFor(data),
    to: data.to,
  }),
  html: (data: MissedNotificationsDigestData, ctx?: EmailRenderContext) => {
    const unsubscribeUrl = ctx?.unsubscribeUrl ?? data.unsubscribeUrl;
    const list = data.items
      .map(({ message, url }) => {
        const link = absoluteUrl(url);
        const text = escapeHtml(message);
        return `<li style="margin: 0 0 10px 0;">${
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
      or <a href="${escapeHtml(unsubscribeUrl)}" style="color: ${
      emailTheme.link
    };">unsubscribe from this one</a>.`;
    return simpleEmailWithTemplate({
      icon: '📬',
      accent: 'blue',
      eyebrow: 'Weekly digest',
      header: escapeHtml(`Notifications you missed this week`),
      body: `<p style="margin: 0;">${escapeHtml(
        `You have ${countLabel(data)} on Civitai you haven't seen.`
      )}</p><ul style="margin: 16px 0; text-align: left; padding-left: 20px;">${list}</ul>${
        more ? `<p>${escapeHtml(more)}</p>` : ''
      }`,
      btnUrl: escapeHtml(data.allUrl ?? notificationsPageUrl()),
      btnLabel: 'See all notifications',
      footer,
    });
  },
  text: (data: MissedNotificationsDigestData, ctx?: EmailRenderContext) => {
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
      `See all notifications: ${data.allUrl ?? notificationsPageUrl()}`,
      `You're getting this because "${MISSED_DIGEST_DISPLAY_NAME}" is on.`,
      `Manage notification emails: ${notificationSettingsUrl()}`,
      `Unsubscribe from this one: ${ctx?.unsubscribeUrl ?? data.unsubscribeUrl}`,
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
