import { escape as escapeHtml } from 'he';
import { createEmail } from '~/server/email/templates/base.email';
import {
  renderEmailCallout,
  renderEmailSummary,
  simpleEmailWithTemplate,
} from '~/server/email/templates/util';
import { titleCase } from '~/utils/string-helpers';
import { getBaseUrl } from '~/server/utils/url-helpers';

type MembershipGiftReceivedData = {
  to: string;
  username: string;
  tier: string;
  months: number;
  /** Gifter's username, or null when the gift was sent anonymously */
  from: string | null;
  message?: string | null;
};

const describeGift = ({ tier, months }: Pick<MembershipGiftReceivedData, 'tier' | 'months'>) =>
  `${months} month${months === 1 ? '' : 's'} of ${titleCase(tier)} membership`;

const describeGifter = (from: string | null) => (from ? `@${from}` : 'Someone');

export const membershipGiftReceivedEmail = createEmail({
  header: ({ to, from, tier, months }: MembershipGiftReceivedData) => ({
    subject: `${describeGifter(from)} gifted you ${describeGift({ tier, months })}! 🎁`,
    to,
  }),
  html({ username, tier, months, from, message }: MembershipGiftReceivedData) {
    const note = message
      ? renderEmailCallout(`<strong>They said:</strong><br/>${escapeHtml(message)}`, {
          accent: 'violet',
        })
      : '';

    return simpleEmailWithTemplate({
      icon: '🎁',
      accent: 'violet',
      eyebrow: 'Membership gift',
      header: `Hi ${escapeHtml(username)}, you've received a gift!`,
      body: `
        <p style="margin: 0;">
          <strong>${escapeHtml(describeGifter(from))}</strong> gifted you
          <strong>${describeGift({ tier, months })}</strong> on Civitai.
        </p>
        ${renderEmailSummary([
          { label: 'From', value: escapeHtml(describeGifter(from)) },
          { label: 'Gift', value: describeGift({ tier, months }) },
        ])}
        ${note}
        <p>
          It's waiting for you on your membership page. Accept it whenever you like — you'll see
          exactly what it does for your account before you do.
        </p>
      `,
      btnLabel: 'See My Gift',
      btnUrl: `${getBaseUrl()}/user/membership#membership-gifts`,
    });
  },
  text({ username, tier, months, from, message }: MembershipGiftReceivedData) {
    const note = message ? ` They said: "${message}"` : '';
    return `Hi ${username}, ${describeGifter(from)} gifted you ${describeGift({
      tier,
      months,
    })} on Civitai!${note} It's waiting for you. Accept it at ${getBaseUrl()}/user/membership#membership-gifts`;
  },
  testData: async () => ({
    to: 'test@tester.com',
    username: 'Testerson',
    tier: 'gold',
    months: 3,
    from: 'GenerousGifter',
    message: 'Happy birthday! Go make something cool.',
  }),
});
