import { createEmail } from '~/server/email/templates/base.email';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { simpleEmailWithTemplate } from '~/server/email/templates/util';

type BountyAwardedData = {
  bounty: {
    id: number;
    name: string;
  };
  entry: {
    id: number;
  };
  user: {
    email: string | null;
  };
};

const bountyEntryUrl = (
  bounty: BountyAwardedData['bounty'],
  bountyEntry: BountyAwardedData['entry']
) => getBaseUrl() + `/bounties/${bounty.id}/entries/${bountyEntry.id}`;

export const bountyAutomaticallyAwardedEmail = createEmail({
  header: ({ user, bounty }: BountyAwardedData) => ({
    subject: `Your bounty "${bounty.name}" has been awarded automatically`,
    to: user.email,
  }),
  html({ bounty, entry }: BountyAwardedData) {
    return simpleEmailWithTemplate({
      header: 'Your bounty has been automatically awarded.',
      body: 'Because no action was taken in 48 hours, your bounty has been automatically awarded to the entry with the most reactions.',
      btnLabel: 'Check the awarded entry',
      btnUrl: bountyEntryUrl(bounty, entry),
    });
  },

  /** Email Text body (fallback for email clients that don't render HTML, e.g. feature phones) */
  text({ bounty, entry }: BountyAwardedData) {
    return `Your bounty "${bounty.name}" been awarded automatically:\n${bountyEntryUrl(
      bounty,
      entry
    )}\n\n`;
  },
  testData: async () => ({
    bounty: {
      id: 1,
      name: 'Test Bounty',
    },
    entry: {
      id: 1,
    },
    user: {
      email: 'test@tester.com',
    },
  }),
});
