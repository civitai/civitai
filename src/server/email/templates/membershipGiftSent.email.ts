import { escape as escapeHtml } from 'he';
import { createEmail } from '~/server/email/templates/base.email';
import { simpleEmailWithTemplate } from '~/server/email/templates/util';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { titleCase } from '~/utils/string-helpers';

type MembershipGiftSentData = {
  to: string;
  username: string;
  tier: string;
  months: number;
  recipient: string | null;
  anonymous?: boolean;
};

const describeGift = ({ tier, months }: Pick<MembershipGiftSentData, 'tier' | 'months'>) =>
  `${months} month${months === 1 ? '' : 's'} of ${titleCase(tier)} membership`;

const describeRecipient = (recipient: string | null) =>
  recipient ? `@${recipient}` : 'your recipient';

export const membershipGiftSentEmail = createEmail({
  header: ({ to, recipient, tier, months }: MembershipGiftSentData) => ({
    subject: `Your gift of ${describeGift({ tier, months })} was delivered to ${describeRecipient(
      recipient
    )}`,
    to,
  }),
  html({ username, tier, months, recipient, anonymous }: MembershipGiftSentData) {
    const anonymousNote = anonymous
      ? `<p>You sent this anonymously, so ${escapeHtml(
          describeRecipient(recipient)
        )} wasn't told who it came from.</p>`
      : '';

    return simpleEmailWithTemplate({
      header: `Thanks ${escapeHtml(username)}, your gift has been delivered!`,
      body: `
        <p>
          Your gift of <strong>${describeGift({ tier, months })}</strong> has been delivered to
          <strong>${escapeHtml(describeRecipient(recipient))}</strong> and is active on their
          account.
        </p>
        ${anonymousNote}
        <p>
          If something doesn't look right, contact
          <a href="mailto:hello@civitai.com">hello@civitai.com</a>.
        </p>
      `,
      btnLabel: 'View My Gifts',
      btnUrl: `${getBaseUrl()}/user/membership`,
    });
  },
  text({ username, tier, months, recipient, anonymous }: MembershipGiftSentData) {
    const anonymousNote = anonymous ? ' It was sent anonymously.' : '';
    return `Thanks ${username}! Your gift of ${describeGift({
      tier,
      months,
    })} has been delivered to ${describeRecipient(
      recipient
    )} and is active on their account.${anonymousNote} See your gifts at ${getBaseUrl()}/user/membership`;
  },
  testData: async () => ({
    to: 'test@tester.com',
    username: 'Testerson',
    tier: 'gold',
    months: 3,
    recipient: 'LuckyRecipient',
    anonymous: false,
  }),
});
