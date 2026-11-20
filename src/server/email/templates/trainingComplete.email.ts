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

const reviewUrl = (model: TrainingCompleteEmailData['model']) =>
  getBaseUrl() + `/models/${model.id}/wizard`;

export const trainingCompleteEmail = createEmail({
  header: ({ user, model, mName }: TrainingCompleteEmailData) => ({
    subject: `Your model "${model.name} - ${mName}" is ready for review`,
    to: user.email,
  }),
  html({ model }: TrainingCompleteEmailData) {
    return simpleEmailWithTemplate({
      header: 'Your model is ready for review! 🎉',
      body: `<p style="margin: 0;">The wait is over! Click the button below to review some sample images and prepare your model for publishing, if you choose to share it. Your training files and job results will be retained on our side for 30 days &mdash; make sure you've published or downloaded what you want to keep before then.</p>`,
      btnUrl: escapeHtml(reviewUrl(model)),
      btnLabel: 'Review Model',
    });
  },

  /** Email Text body (fallback for email clients that don't render HTML, e.g. feature phones) */
  text({ mName, model }: TrainingCompleteEmailData) {
    return `Your model "${model.name} - ${mName}" is ready for review:\n${reviewUrl(
      model
    )}\n\nYour training files and job results will be retained on our side for 30 days. Make sure you've published or downloaded what you want to keep before then.\n\n`;
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
