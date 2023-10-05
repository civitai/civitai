import { createEmail } from '~/server/email/templates/base.email';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { simpleEmailWithTemplate } from '~/server/email/templates/util';

type BountyExpiredData = {
  bounty: {
    id: number;
    name: string;
  };
  user: {
    username: string;
    email: string;
  };
};

function getRefundFormUrl({ user, bounty }: BountyExpiredData) {
  const qsParts = new URLSearchParams({
    'Your Civitai Username': user.username,
    'Name of the bounty': bounty.name,
    'Link to the bounty': bountyUrl(bounty),
  });
  return `${getBaseUrl()}/forms/bounty-refund?${qsParts.toString()}`;
}

const bountyUrl = (bounty: BountyExpiredData['bounty']) => getBaseUrl() + `/bounties/${bounty.id}`;
export const bountyExpiredReminderEmail = createEmail({
  header: ({ user, bounty }: BountyExpiredData) => ({
    subject: `Reminder: Your bounty "${bounty.name}" expired and you have not awarded any entries`,
    to: user.email,
  }),
  html({ user, bounty }: BountyExpiredData) {
    const refundUrl = getRefundFormUrl({ user, bounty });
    return simpleEmailWithTemplate({
      header: `Reminder: Your bounty <strong>${bounty.name}</strong> has expired!`,
      body: `
       <p>
          It looks like you still have not awarded a winner. Be sure to check out the entries and award the one that you like the most!
       </p>
       <p>
          If you don't like any of the entries, you can submit a bounty refund request using this <a href="${refundUrl}" target="blank">request form</a>.
       </p>
       <p style="color: red;">You have 24 hours to request a refund or award an entry. Otherwise, your bounty will be awarded to the entry with the most reactions.</p>
      `,
      btnLabel: 'Check out all entries!',
      btnUrl: bountyUrl(bounty),
    });
  },

  /** Email Text body (fallback for email clients that don't render HTML, e.g. feature phones) */
  text({ bounty }: BountyExpiredData) {
    return `Reminder: Your bounty "${bounty.name}" has expired:\n${bountyUrl(bounty)}\n\n`;
  },
  testData: async () => ({
    bounty: {
      id: 1,
      name: 'Test Bounty',
    },
    user: {
      username: 'test',
      email: 'test@tester.com',
    },
  }),
});
