import { createEmail } from '~/server/email/templates/base.email';
import { simpleEmailWithTemplate } from '~/server/email/templates/util';

type MerchBuzzCreditedData = {
  to: string;
  username: string;
  buzzAmount: number;
};

export const merchBuzzCreditedEmail = createEmail({
  header: ({ to }: MerchBuzzCreditedData) => ({
    subject: 'Your Civitai merch order earned you Blue Buzz',
    to,
  }),
  html({ username, buzzAmount }: MerchBuzzCreditedData) {
    return simpleEmailWithTemplate({
      header: 'Thanks for your order!',
      body: `
      <p>
        <strong>⚡${buzzAmount.toLocaleString()} Blue Buzz</strong> has been added to your Civitai account
        <strong>${username}</strong>.
      </p>
      <p>
        Your store account is already linked to Civitai, so it was credited automatically - nothing else
        to do. If that isn't the right account, contact
        <a href="mailto:hello@civitai.com">hello@civitai.com</a> and we'll sort it out.
      </p>`,
    });
  },
  text({ username, buzzAmount }: MerchBuzzCreditedData) {
    return `${buzzAmount.toLocaleString()} Blue Buzz was added to your Civitai account ${username}. It was credited automatically since your store account is linked. Wrong account? Contact hello@civitai.com.`;
  },
  testData: async () => ({
    to: 'test@tester.com',
    username: 'Testerson',
    buzzAmount: 5000,
  }),
});
