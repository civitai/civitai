import { escape as escapeHtml } from 'he';
import { createEmail } from '~/server/email/templates/base.email';
import { simpleEmailWithTemplate } from '~/server/email/templates/util';
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
  mName: string;
};

const reviewUrl = (username: TrainingCompleteEmailData['user']['username']) =>
  getBaseUrl() + `/user/${username}/models?section=training`;

export const trainingFailEmail = createEmail({
  header: ({ user, mName, model }: TrainingCompleteEmailData) => ({
    subject: `Your model "${model.name} - ${mName}" failed to train`,
    to: user.email,
  }),
  html({ user, model, mName }: TrainingCompleteEmailData) {
    return simpleEmailWithTemplate({
      header: 'Your model failed to train 😞',
      body: `<p style="margin: 0;">Unfortunately, this model ("${escapeHtml(
        model.name
      )} - ${escapeHtml(
        mName
      )}") failed to train properly. If you have not yet received your refund, you should receive it within 24 hours.</p>`,
      btnUrl: escapeHtml(reviewUrl(user.username)),
      btnLabel: 'Go To Dashboard',
    });
  },

  /** Email Text body (fallback for email clients that don't render HTML, e.g. feature phones) */
  text({ user, model, mName }: TrainingCompleteEmailData) {
    return `Your model "${model.name} - ${mName}" failed to train:\n${reviewUrl(
      user.username
    )}\n\n`;
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
    mName: 'V1',
  }),
});
