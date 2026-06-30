import { createEmail } from '~/server/email/templates/base.email';
import { simpleEmailWithTemplate } from '~/server/email/templates/util';

type MerchClaimInviteData = {
  to: string;
  buzzAmount: number;
  claimUrl: string;
};

export const merchClaimInviteEmail = createEmail({
  header: ({ to }: MerchClaimInviteData) => ({
    subject: 'Claim your Blue Buzz from your Civitai merch order',
    to,
  }),
  html({ buzzAmount, claimUrl }: MerchClaimInviteData) {
    return simpleEmailWithTemplate({
      header: 'Thanks for your order!',
      body: `
      <p>
        Your Civitai merch purchase earned you <strong>⚡${buzzAmount.toLocaleString()} Blue Buzz</strong>.
      </p>
      <p>
        Click below to add it to your Civitai account. You only need to do this once - after that, Buzz
        from future orders is added automatically.
      </p>`,
      btnLabel: 'Claim your Buzz',
      btnUrl: claimUrl,
    });
  },
  text({ buzzAmount, claimUrl }: MerchClaimInviteData) {
    return `Your Civitai merch order earned ${buzzAmount.toLocaleString()} Blue Buzz. Claim it: ${claimUrl}`;
  },
  testData: async () => ({
    to: 'test@tester.com',
    buzzAmount: 5000,
    claimUrl: 'https://civitai.com/merch/claim?order=example',
  }),
});
