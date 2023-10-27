import { createEmail } from '~/server/email/templates/base.email';
import { getBaseUrl } from '~/server/utils/url-helpers';

type TrainingCompleteEmailData = {
  model: {
    id: number;
    name: string;
  };
  user: {
    email: string | null;
    username: string | null;
  };
};

const reviewUrl = (model: TrainingCompleteEmailData['model']) =>
  getBaseUrl() + `/models/${model.id}/wizard`;

export const trainingCompleteEmail = createEmail({
  header: ({ user, model }: TrainingCompleteEmailData) => ({
    subject: `Your model "${model.name}" is ready for review`,
    to: user.email,
  }),
  html({ user, model }: TrainingCompleteEmailData) {
    const brandColor = '#346df1';
    const color = {
      background: '#f9f9f9',
      text: '#444',
      mainBackground: '#fff',
      buttonBackground: brandColor,
      buttonBorder: brandColor,
      buttonText: '#fff',
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
              Your model is ready for review! 🎉
            </td>
          </tr>
          <tr>
            <td
              style="padding: 0px 0px 10px 0px; font-size: 16px; line-height: 22px; font-family: Helvetica, Arial, sans-serif; color: ${
                color.text
              };">
              The wait is over! Click the button below to review some sample images and prepare your model for publishing, if you choose to share it. Results will remain available for 30 days.
            </td>
          </tr>
          <tr>
            <td align="center" style="padding: 0;">
              <table border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td align="center" style="border-radius: 5px;" bgcolor="${
                    color.buttonBackground
                  }"><a href="${reviewUrl(model)}"
                      target="_blank"
                      style="font-size: 18px; font-family: Helvetica, Arial, sans-serif; color: ${
                        color.buttonText
                      }; text-decoration: none; border-radius: 5px; padding: 10px 20px; border: 1px solid ${
      color.buttonBorder
    }; display: inline-block; font-weight: bold;">Review Model</a></td>
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
  text({ model }: TrainingCompleteEmailData) {
    return `Your model "${model.name}" is ready for review:\n${reviewUrl(model)}\n\n`;
  },
  testData: async () => ({
    model: {
      id: 1,
      name: 'Test Model',
    },
    user: {
      email: 'test@test.com',
      username: 'tester',
    },
  }),
});
