import { createEmail } from '~/server/email/templates/base.email';
import { simpleEmailWithTemplate } from '~/server/email/templates/util';

type MerchClaimConfirmationData = {
  to: string;
  username: string;
  buzzAmount: number;
  confirmUrl: string;
};

export const merchClaimConfirmationEmail = createEmail({
  header: ({ to }: MerchClaimConfirmationData) => ({
    subject: 'Confirm your Civitai merch Buzz reward',
    to,
  }),
  html({ username, buzzAmount, confirmUrl }: MerchClaimConfirmationData) {
    return simpleEmailWithTemplate({
      header: `Hey ${username}!`,
      body: `
      <p>
        Someone linked this email to a Civitai account to claim <strong>⚡${buzzAmount.toLocaleString()} Blue Buzz</strong> from a merch order.
      </p>
      <p>
        If that was you, confirm below to add the Buzz to your account and link your store orders for automatic rewards going forward. If it wasn't you, you can safely ignore this email.
      </p>`,
      btnLabel: 'Confirm & Claim Buzz',
      btnUrl: confirmUrl,
    });
  },
  text({ buzzAmount, confirmUrl }: MerchClaimConfirmationData) {
    return `Confirm your Civitai merch Buzz reward (${buzzAmount.toLocaleString()} Blue Buzz): ${confirmUrl}`;
  },
  testData: async () => ({
    to: 'test@tester.com',
    username: 'Testerson',
    buzzAmount: 5000,
    confirmUrl: 'https://civitai.com/merch/claim?token=example',
  }),
});
