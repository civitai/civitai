import { createEmail } from '~/server/email/templates/base.email';
import { getBaseUrl } from '~/server/utils/url-helpers';

type BountyAwardedData = {
  bounty: {
    id: number;
    name: string;
  };
  entry: {
    id: number;
  };
  user: {
    email: string | null;
  };
};

const bountyUrl = (bounty: BountyAwardedData['bounty']) => getBaseUrl() + `/bounties/${bounty.id}`;
const bountyEntryUrl = (
  bounty: BountyAwardedData['bounty'],
  bountyEntry: BountyAwardedData['entry']
) => getBaseUrl() + `/bounties/${bounty.id}/entries/${bountyEntry.id}`;

export const bountyAutomaticallyAwardedEmail = createEmail({
  header: ({ user, bounty }: BountyAwardedData) => ({
    subject: `Your bounty "${bounty.name}" has been awarded automatically`,
    to: user.email,
  }),
  html({ bounty, entry }: BountyAwardedData) {
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
              Your bounty has been automatically awarded.
            </td>
          </tr>
          <tr>
            <td
              style="padding: 0px 0px 10px 0px; font-size: 16px; line-height: 22px; font-family: Helvetica, Arial, sans-serif; color: ${
                color.text
              };">
             <p>
                Because no action was taken in 48 hours, your bounty has been automatically awarded to the entry with the most reactions.
             </p> 
             </td>
          </tr>
          <tr>
            <td align="center" style="padding: 0;">
              <table border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td align="center" style="border-radius: 5px;" bgcolor="${
                    color.buttonBackground
                  }"><a href="${bountyEntryUrl(bounty, entry)}"
                      target="_blank"
                      style="font-size: 18px; font-family: Helvetica, Arial, sans-serif; color: ${
                        color.buttonText
                      }; text-decoration: none; border-radius: 5px; padding: 10px 20px; border: 1px solid ${
      color.buttonBorder
    }; display: inline-block; font-weight: bold;">Check the awarded entry</a></td>
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
  text({ bounty, entry }: BountyAwardedData) {
    return `Your bounty "${bounty.name}" been awarded automatically:\n${bountyEntryUrl(
      bounty,
      entry
    )}\n\n`;
  },
  testData: async () => ({
    bounty: {
      id: 1,
      name: 'Test Test Bounty',
    },
    entry: {
      id: 1,
    },
    user: {
      email: 'test@tester.com',
    },
  }),
});
