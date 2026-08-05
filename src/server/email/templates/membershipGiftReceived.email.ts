import { escape as escapeHtml } from 'he';
import { createEmail } from '~/server/email/templates/base.email';
import { simpleEmailWithTemplate } from '~/server/email/templates/util';
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
    const note = message ? `<p><strong>They said:</strong><br/>${escapeHtml(message)}</p>` : '';

    return simpleEmailWithTemplate({
      header: `Hi ${escapeHtml(username)}, you've received a gift! 🎁`,
      body: `
        <p>
          <strong>${escapeHtml(describeGifter(from))}</strong> gifted you
          <strong>${describeGift({ tier, months })}</strong> on Civitai.
        </p>
        ${note}
        <p>
          It's already active on your account — nothing to do but enjoy it. When the gifted months
          run out your membership simply ends; you won't be charged unless you choose to keep it.
        </p>
      `,
      btnLabel: 'View My Membership',
      btnUrl: `${getBaseUrl()}/user/membership`,
    });
  },
  text({ username, tier, months, from, message }: MembershipGiftReceivedData) {
    const note = message ? ` They said: "${message}"` : '';
    return `Hi ${username}, ${describeGifter(from)} gifted you ${describeGift({
      tier,
      months,
    })} on Civitai!${note} It's already active on your account. View it at ${getBaseUrl()}/user/membership`;
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
