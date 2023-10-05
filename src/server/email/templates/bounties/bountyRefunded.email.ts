import { createEmail } from '~/server/email/templates/base.email';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { simpleEmailWithTemplate } from '~/server/email/templates/util';

type BountyExpiredData = {
  bounty: {
    id: number;
    name: string;
  };
  user: {
    email: string | null;
  };
};

const bountyUrl = (bounty: BountyExpiredData['bounty']) => getBaseUrl() + `/bounties/${bounty.id}`;
export const bountyRefundedEmail = createEmail({
  header: ({ user, bounty }: BountyExpiredData) => ({
    subject: `Your bounty "${bounty.name}" has been refunded`,
    to: user.email,
  }),
  html({ bounty }: BountyExpiredData) {
    return simpleEmailWithTemplate({
      header: `Your bounty <strong>${bounty.name}</strong> has been refunded.`,
      body: `
       <p>
          The buzz you had put down for your bounty has been returned to your account and you can use it to create a new bounty expecting better results.
       </p> 
       <p>If you requested a refund for your bounties because you did not like any of the entries, try increasing the award amount so that more experienced creators jump in.  </p>
       <p>If a refund was issued because no entries were posted, consider improving the bounty&rsquo;s description, details or prize pool.</p>
      `,
      btnLabel: 'Go to my bounty',
      btnUrl: bountyUrl(bounty),
    });
  },

  /** Email Text body (fallback for email clients that don't render HTML, e.g. feature phones) */
  text({ bounty }: BountyExpiredData) {
    return `Your bounty "${bounty.name}" has been refunded:\n${bountyUrl(bounty)}\n\n`;
  },
  testData: async () => ({
    bounty: {
      id: 1,
      name: 'Test Bounty',
    },
    user: {
      email: 'test@tester.com',
    },
  }),
});
