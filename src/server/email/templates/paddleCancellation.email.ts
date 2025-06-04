import { createEmail } from '~/server/email/templates/base.email';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { simpleEmailWithTemplate } from '~/server/email/templates/util';

type PaddleCancelationData = {
  email: string | null;
};

export const paddleCancellationEmail = createEmail({
  header: ({ email }: PaddleCancelationData) => ({
    subject: `Cancel Subscription: ${email}`,
    // to: `assist@paddle.com`,
    to: `justin@civitai.com`,
  }),
  html({ email }: PaddleCancelationData) {
    return simpleEmailWithTemplate({
      header: `Cancellation Support Requested`,
      body: `
      <p>
        We request your assistance in canceling the subscription of:<br/><code>${email}</code>
      </p>
      <p>
        Best regards, <br />
        The Civitai Team
      </p>`,
    });
  },
  /** Email Text body (fallback for email clients that don't render HTML, e.g. feature phones) */
  text({ email }: PaddleCancelationData) {
    return `Request to cancel subscription for ${email}`;
  },
  testData: async () => ({
    email: 'test@tester.com',
  }),
});
