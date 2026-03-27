import { createEmail } from '~/server/email/templates/base.email';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { simpleEmailWithTemplate } from '~/server/email/templates/util';

type PrepaidTokenUnlockedData = {
  user: {
    email: string | null;
    username: string;
  };
  tokensUnlocked: number;
  totalBuzz: number;
};

const membershipUrl = () => getBaseUrl() + `/user/membership`;

export const prepaidTokenUnlockedEmail = createEmail({
  header: ({ user, tokensUnlocked }: PrepaidTokenUnlockedData) => ({
    subject: `${tokensUnlocked} Membership Token${tokensUnlocked !== 1 ? 's' : ''} Ready to Claim on Civitai`,
    to: user.email,
  }),
  html({ user, tokensUnlocked, totalBuzz }: PrepaidTokenUnlockedData) {
    return simpleEmailWithTemplate({
      header: `Hey ${user.username}!`,
      body: `
      <p>
        Great news — <strong>${tokensUnlocked} membership token${tokensUnlocked !== 1 ? 's have' : ' has'}</strong> been unlocked on your account, worth a total of <strong>⚡${totalBuzz.toLocaleString()} Buzz</strong>.
      </p>
      <p>
        Head to your membership page to claim ${tokensUnlocked !== 1 ? 'them' : 'it'} and add the Buzz to your balance.
      </p>
      <p>
        Best,<br />
        The Civitai Team
      </p>`,
      btnLabel: 'Claim Your Tokens',
      btnUrl: membershipUrl(),
    });
  },
  text({ tokensUnlocked, totalBuzz }: PrepaidTokenUnlockedData) {
    return `${tokensUnlocked} membership token${tokensUnlocked !== 1 ? 's are' : ' is'} ready to claim (${totalBuzz.toLocaleString()} Buzz). Visit ${membershipUrl()} to claim.`;
  },
  testData: async () => ({
    user: {
      email: 'test@tester.com',
      username: 'Testerson',
    },
    tokensUnlocked: 3,
    totalBuzz: 75000,
  }),
});
