import { createEmail } from '~/server/email/templates/base.email';
import { emailTheme, simpleEmailWithTemplate } from '~/server/email/templates/util';
import { getBaseUrl } from '~/server/utils/url-helpers';

type RedeemableCodePurchaseData = {
  email: string;
  username: string;
  code: string;
  type: 'Buzz' | 'Membership';
  unitValue: number;
};

export const redeemableCodePurchaseEmail = createEmail({
  template: 'redeemableCodePurchase',
  mailClass: 'transactional',
  header: ({ email }: RedeemableCodePurchaseData) => ({
    subject: 'Your Civitai Redeemable Code is Ready!',
    to: email,
  }),
  html({ username, code, type, unitValue }: RedeemableCodePurchaseData) {
    const description =
      type === 'Buzz' ? `${unitValue.toLocaleString()} Buzz` : `${unitValue}-month Membership`;

    return simpleEmailWithTemplate({
      icon: '🎟️',
      accent: type === 'Buzz' ? 'buzz' : 'violet',
      eyebrow: 'Redeemable code',
      header: `Hi ${username}, your code is ready!`,
      body: `
        <p style="margin: 0;">Your crypto purchase is complete. Here is your redeemable code for <strong>${description}</strong>:</p>
        <table role="presentation" class="em-panel" width="100%" border="0" cellspacing="0" cellpadding="0" bgcolor="${emailTheme.panel}" style="margin: 16px 0; background-color: ${emailTheme.panel}; border: 1px dashed ${emailTheme.border}; border-radius: 8px;">
          <tr>
            <td class="em-text" align="center" style="padding: 20px 16px; color: ${emailTheme.text}; font-family: Menlo, Consolas, 'Courier New', monospace; font-size: 24px; line-height: 32px; letter-spacing: 2px; text-align: center;">
              <strong>${code}</strong>
            </td>
          </tr>
        </table>
        <p style="margin: 0;">You can redeem this code yourself or share it as a gift.</p>
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
