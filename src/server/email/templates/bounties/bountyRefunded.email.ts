import { createEmail } from '~/server/email/templates/base.email';
import { getBaseUrl } from '~/server/utils/url-helpers';

type BountyExpiredData = {
  bounty: {
    id: number;
    name: string;
  };
  user: {
    email: string | null;
  };
};

const bountyUrl = (bounty: BountyExpiredData['bounty']) => getBaseUrl() + `/bounties/${bounty.id}`;
const bountyRefundUrl = (bounty: BountyExpiredData['bounty']) =>
  getBaseUrl() + `/bounties/${bounty.id}`;

export const bountyExpiredReminderEmail = createEmail({
  header: ({ user, bounty }: BountyExpiredData) => ({
    subject: `Reminder: Your bounty "${bounty.name}" expired and you have not awarded any entries`,
    to: user.email,
  }),
  html({ user, bounty }: BountyExpiredData) {
    const brandColor = '#346df1';
    const color = {
      background: '#f9f9f9',
      text: '#444',
      mainBackground: '#fff',
      buttonBackground: brandColor,
      buttonBorder: brandColor,
      buttonText: '#fff',
      dangerButtonBackground: '#f44336',
    };

    return `
  <body style="background: ${color.background};">
    <table width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 600px; margin: auto;">
      <tr><td height="20"></td></tr>
      <tr><td>
        <table width="100%" border="0" cellspacing="20" cellpadding="0" style="background: ${
          color.mainBackground
        }; border-radius: 10px;">
          <tr>
            <td align="center"
              style="padding: 10px 0px; font-size: 22px; font-family: Helvetica, Arial, sans-serif; color: ${
                color.text
              };">
              It looks like your bounty <strong>${bounty.name}</strong> just expired!
            </td>
          </tr>
          <tr>
            <td
              style="padding: 0px 0px 10px 0px; font-size: 16px; line-height: 22px; font-family: Helvetica, Arial, sans-serif; color: ${
                color.text
              };">
             <p>
                It looks like you still have not awarded a winner. Be sure to check out the entries and award the one that you like the most!
             </p>
             <p>
                If you don't like any of the entries, you can contact us at <a href="mailto:hello@civitai.com">hello@civitai.com</a> so we can get in touch with you to refund you.
             </p>
             <p>You have 24 hours to contact us or award an entry. Otherwise, your bounty will be awarded to the entry with the most reactions.</p>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding: 0;">
              <table border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td align="center" style="border-radius: 5px;" bgcolor="${
                    color.buttonBackground
                  }"><a href="${bountyUrl(bounty)}"
                      target="_blank"
                      style="font-size: 18px; font-family: Helvetica, Arial, sans-serif; color: ${
                        color.buttonText
                      }; text-decoration: none; border-radius: 5px; padding: 10px 20px; border: 1px solid ${
      color.buttonBorder
    }; display: inline-block; font-weight: bold;">Check out all entries!</a></td>
                </tr>
              </table>
            </td>
          </tr> 
        </table>
      </td></tr>
      <tr><td height="20"></td></tr>
    </table>
  </body>
  `;
  },

  /** Email Text body (fallback for email clients that don't render HTML, e.g. feature phones) */
  text({ bounty }: BountyExpiredData) {
    return `Reminder: Your bounty "${bounty.name}" has expired:\n${bountyUrl(bounty)}\n\n`;
  },
  testData: async () => ({
    bounty: {
      id: 1,
      name: 'Test Test Bounty',
    },
    user: {
      email: 'test@tester.com',
    },
  }),
});
