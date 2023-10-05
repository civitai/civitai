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
export const bountyExpiredReminderEmail = createEmail({
  header: ({ user, bounty }: BountyExpiredData) => ({
    subject: `Reminder: Your bounty "${bounty.name}" expired and you have not awarded any entries`,
    to: user.email,
  }),
  html({ user, bounty }: BountyExpiredData) {
    return simpleEmailWithTemplate({
      header: `Reminder: Your bounty <strong>${bounty.name}</strong> has experired!`,
      body: `
       <p>
          It looks like you still have not awarded a winner. Be sure to check out the entries and award the one that you like the most!
       </p>
       <p>
          If you don't like any of the entries, you can contact us at <a href="mailto:hello@civitai.com">hello@civitai.com</a> so we can get in touch with you to refund you.
       </p>
       <p>You have 24 hours to contact us or award an entry. Otherwise, your bounty will be awarded to the entry with the most reactions.</p>
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
      email: 'test@tester.com',
    },
  }),
});
