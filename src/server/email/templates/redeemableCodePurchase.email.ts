import { createEmail } from '~/server/email/templates/base.email';
import { simpleEmailWithTemplate } from '~/server/email/templates/util';
import { getBaseUrl } from '~/server/utils/url-helpers';

type RedeemableCodePurchaseData = {
  email: string;
  username: string;
  code: string;
  type: 'Buzz' | 'Membership';
  unitValue: number;
};

export const redeemableCodePurchaseEmail = createEmail({
  header: ({ email }: RedeemableCodePurchaseData) => ({
    subject: 'Your Civitai Redeemable Code is Ready!',
    to: email,
  }),
  html({ username, code, type, unitValue }: RedeemableCodePurchaseData) {
    const description =
      type === 'Buzz' ? `${unitValue.toLocaleString()} Buzz` : `${unitValue}-month Membership`;

    return simpleEmailWithTemplate({
      header: `Hi ${username}, your code is ready!`,
      body: `
        Your crypto purchase is complete. Here is your redeemable code for <strong>${description}</strong>:
        <br/><br/>
        <div style="text-align:center; padding:16px; background:#f0f0f0; border-radius:8px; font-size:24px; font-family:monospace; letter-spacing:2px;">
          <strong>${code}</strong>
        </div>
        <br/>
        You can redeem this code yourself or share it as a gift.
      `,
      btnLabel: 'Redeem Code',
      btnUrl: `${getBaseUrl()}/redeem-code`,
    });
  },
  text({ username, code, type, unitValue }: RedeemableCodePurchaseData) {
    const description =
      type === 'Buzz' ? `${unitValue.toLocaleString()} Buzz` : `${unitValue}-month Membership`;
    return `Hi ${username}, your crypto purchase is complete. Your redeemable code for ${description}: ${code}. Redeem at ${getBaseUrl()}/redeem-code`;
  },
  testData: async () => ({
    email: 'test@tester.com',
    username: 'Testerson',
    code: 'CS-ABCD-EFGH',
    type: 'Buzz' as const,
    unitValue: 10000,
  }),
});
