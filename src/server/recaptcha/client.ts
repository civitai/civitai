import { RecaptchaEnterpriseServiceClient } from '@google-cloud/recaptcha-enterprise';
import { env } from '~/env/server.mjs';

const client = new RecaptchaEnterpriseServiceClient();

export async function createRecaptchaAssesment({
  token,
  recaptchaAction,
}: {
  token: string;
  recaptchaAction: string;
}) {
  // Create the reCAPTCHA client.
  const projectPath = client.projectPath(env.RECAPTCHA_PROJECT_ID);

  // Build the assessment request.
  const request = {
    assessment: {
      event: {
        token: token,
        siteKey: env.NEXT_PUBLIC_RECAPTCHA_KEY,
      },
    },
    parent: projectPath,
  };

  const [response] = await client.createAssessment(request);

  if (!response || !response.tokenProperties || !response.riskAnalysis) {
    throw new Error('No response from reCAPTCHA service');
  }

  // Check if the token is valid.
  if (!response.tokenProperties?.valid) {
    throw new Error(`Recaptcha failed: ${response.tokenProperties?.invalidReason}`);
  }

  if (response.tokenProperties.action === recaptchaAction) {
    return response.riskAnalysis.score;
  } else {
    throw new Error('Provided token does not match performed action');
  }
}
