import { createEmail } from '~/server/email/templates/base.email';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { simpleEmailWithTemplate } from '~/server/email/templates/util';

type SubscriptionRenewalReminderData = {
  user: {
    email: string | null;
    username: string;
  };
};

const membershipUrl = () => getBaseUrl() + `/pricing`;

export const subscriptionRenewalReminderEmail = createEmail({
  header: ({ user }: SubscriptionRenewalReminderData) => ({
    subject: `Important Update: Payment Method Changes on Civitai`,
    to: user.email,
  }),
  html({ user }: SubscriptionRenewalReminderData) {
    return simpleEmailWithTemplate({
      header: `Dear ${user.username},`,
      body: `
      <p>
        We hope you're enjoying your experience on Civitai! We're reaching out to inform you about some important changes regarding our payment system.
      </p>
      <p>
        As part of our ongoing efforts to improve the site, we've recently migrated to a new payment provider. This transition has allowed us to enhance security and improve the overall experience. However, it also means that some payment methods we previously supported, including SEPA, WePay, Link, and CashApp, are no longer available for future transactions.
      </p>
      <p>
        To ensure a smooth experience moving forward, we kindly ask that you update your payment method to one of our newly supported options, such as PayPal. As a token of our appreciation and apology for any inconvenience, we’re pleased to offer you an additional ⚡5000 Buzz when you switch to a new payment method!
      </p>
      <p>
        To update your payment method and check our memberships, You can follow the link at the bottom of this email.
      </p>
      <p>
        Thank you for being part of the Civitai community! Should you have any questions or need assistance with the transition, please don't hesitate to reach out to our support team.
      </p>

      <p>
        Best regards, <br />
        The Civitai Team <br />
        support@civitai.com <br />
        www.civitai.com
      </p>`,
      btnLabel: 'Checkout our Membership Plans',
      btnUrl: membershipUrl(),
    });
  },
  /** Email Text body (fallback for email clients that don't render HTML, e.g. feature phones) */
  text({ user }: SubscriptionRenewalReminderData) {
    return `Our payment system has recently changed. Please update your payment method to continue enjoying Civitai. Visit ${membershipUrl()} to learn more.`;
  },
  testData: async () => ({
    user: {
      email: 'test@tester.com',
      username: 'Testerson',
    },
  }),
});
