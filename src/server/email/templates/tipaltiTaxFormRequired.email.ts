import { createEmail } from '~/server/email/templates/base.email';
import { simpleEmailWithTemplate } from '~/server/email/templates/util';
import { getBaseUrl } from '~/server/utils/url-helpers';

type TipaltiTaxFormRequiredData = {
  email: string | null;
  username?: string | null;
};

export const tipaltiTaxFormRequiredEmail = createEmail({
  header: ({ email }: TipaltiTaxFormRequiredData) => ({
    subject: `Action required: update your tax information to keep receiving payments`,
    to: email,
  }),
  html({ username }: TipaltiTaxFormRequiredData) {
    const greeting = username ? `Hi ${username},` : 'Hi,';
    return simpleEmailWithTemplate({
      header: 'Tax information needed for your Civitai payouts',
      body: `
        <p>${greeting}</p>
        <p>
          Our payments provider (Tipalti) has flagged your account as
          <strong>not payable</strong> because of missing or invalid tax information.
          Until this is resolved, we are not able to send you any further withdrawals.
        </p>
        <p>
          Please head over to your Tipalti setup page and complete or re-submit your tax forms
          (W-9, W-8BEN, etc.) so we can resume your payouts.
        </p>
        <p>
          If you believe this is a mistake, or you need help completing your tax information,
          please reply to this email or contact support.
        </p>
        <p>
          Thanks,<br/>
          The Civitai Team
        </p>
      `,
      btnUrl: `${getBaseUrl()}/tipalti/setup`,
      btnLabel: 'Update tax information',
    });
  },
  text({ username }: TipaltiTaxFormRequiredData) {
    const greeting = username ? `Hi ${username},` : 'Hi,';
    return `${greeting}

Our payments provider (Tipalti) has flagged your account as not payable because of missing or invalid tax information. Until this is resolved, we are not able to send you any further withdrawals.

Please visit ${getBaseUrl()}/tipalti/setup and complete or re-submit your tax forms (W-9, W-8BEN, etc.) so we can resume your payouts.

If you believe this is a mistake, or you need help completing your tax information, please reply to this email or contact support.

Thanks,
The Civitai Team
`;
  },
  testData: async () => ({
    email: 'test@tester.com',
    username: 'testuser',
  }),
});
