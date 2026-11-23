import { createEmail } from '~/server/email/templates/base.email';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { renderEmailSummary, simpleEmailWithTemplate } from '~/server/email/templates/util';

type BountyExpiredData = {
  bounty: {
    id: number;
    name: string;
    entryCount: number;
  };
  user: {
    email: string | null;
  };
};

const bountyUrl = (bounty: BountyExpiredData['bounty']) => getBaseUrl() + `/bounties/${bounty.id}`;

export const bountyExpiredEmail = createEmail({
  header: ({ user, bounty }: BountyExpiredData) => ({
    subject: `Your bounty "${bounty.name}" just expired - check out the entries!`,
    to: user.email,
  }),
  html({ user, bounty }: BountyExpiredData) {
    return simpleEmailWithTemplate({
      icon: '⏰',
      accent: 'buzz',
      eyebrow: 'Bounty expired',
      header: `It looks like your bounty <strong>${bounty.name}</strong> just expired!`,
      body: `
        <p style="margin: 0;">
          It looks like your bounty received about ${
            bounty.entryCount
          } entries. Be sure to check them out and award the one that you like the most!
        </p>
        ${renderEmailSummary([
          { label: 'Entries', value: `About ${bounty.entryCount}` },
          { label: 'Time to award', value: '48 hours' },
        ])}
        <p style="margin: 0;">
          You have 48 hours to award an entry.
        </p>
      `,
      btnLabel: 'Check out all entries!',
      btnUrl: bountyUrl(bounty),
    });
  },

  /** Email Text body (fallback for email clients that don't render HTML, e.g. feature phones) */
  text({ bounty }: BountyExpiredData) {
    return `Your bounty "${bounty.name}" just expired:\n${bountyUrl(bounty)}\n\n`;
  },
  testData: async () => ({
    bounty: {
      id: 1,
      name: 'Test Bounty',
      entryCount: 5,
    },
    user: {
      email: 'test@tester.com',
    },
  }),
});
