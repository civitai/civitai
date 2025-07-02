import { RecaptchaEnterpriseServiceClient, v1 } from '@google-cloud/recaptcha-enterprise';
import { env } from '~/env/server';
import { isDev } from '../../env/other';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { isDefined } from '~/utils/type-guards';
import * as z from 'zod/v4';
import { logToAxiom } from '~/server/logging/client';

// Taken from package as they don't export it :shrug:
// enum ClassificationReason {
//   CLASSIFICATION_REASON_UNSPECIFIED = 0,
//   AUTOMATION = 1,
//   UNEXPECTED_ENVIRONMENT = 2,
//   TOO_MUCH_TRAFFIC = 3,
//   UNEXPECTED_USAGE_PATTERNS = 4,
//   LOW_CONFIDENCE_SCORE = 5,
//   SUSPECTED_CARDING = 6,
//   SUSPECTED_CHARGEBACK = 7,
// }

export async function createRecaptchaAssesment({
  token,
  recaptchaAction,
}: {
  token: string;
  recaptchaAction: string;
}) {
  if (isDev) {
    // Makes it so that you're always authorized on dev.
    return {
      score: 1,
      reasons: [],
    };
  }

  const client = new RecaptchaEnterpriseServiceClient({
    projectId: env.RECAPTCHA_PROJECT_ID,
  });

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
    throw throwBadRequestError('No response from reCAPTCHA service');
  }

  // Check if the token is valid.
  if (!response.tokenProperties?.valid) {
    throw throwBadRequestError(`Recaptcha failed: ${response.tokenProperties?.invalidReason}`);
  }

  if (response.tokenProperties.action === recaptchaAction) {
    return {
      score: response.riskAnalysis.score,
      reasons: (response.riskAnalysis.reasons ?? [])
        .map((reason) => {
          switch (reason) {
            case 1:
              return 'The interaction matches the behavior of an automated agent';
            case 2:
              return 'We could not verify the integrity of the environment detected';
            case 3:
              return 'The amount of traffic detected seems suspiciously high';
            case 4:
              return 'The interaction with your site was significantly different from expected patterns';
            case 5:
              return 'Recaptcha could not validate the authenticity of the user';
            default:
              return undefined;
          }
        })
        .filter(isDefined),
    };
  } else {
    throw throwBadRequestError('Provided token does not match performed action');
  }
}

type SiteVerifyResponse = z.infer<typeof siteVerifyResponseSchema>;
const siteVerifyResponseSchema = z.object({
  success: z.boolean(),
  challenge_ts: z.coerce.date().optional(),
  hostname: z.string().optional(),
  'error-codes': z.array(z.string()),
  action: z.string().optional(),
  cdata: z.string().optional(),
});

export async function verifyCaptchaToken({
  token,
  secret = env.CF_INVISIBLE_TURNSTILE_SECRET || env.CLOUDFLARE_TURNSTILE_SECRET,
  ip,
}: {
  token: string;
  secret?: string;
  ip?: string;
}) {
  const result = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret,
      response: token,
      remoteip: ip,
    }),
  });
  if (!result.ok) throw throwBadRequestError('No response from captcha service');

  const outcome = (await result.json()) as SiteVerifyResponse;
  if (outcome.success) {
    return true;
  } else {
    logToAxiom({ name: 'captcha-failure', type: 'error', response: outcome });
    throw throwBadRequestError('Unable to verify captcha token');
  }
}
