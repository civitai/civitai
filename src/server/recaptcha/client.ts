import { RecaptchaEnterpriseServiceClient, v1 } from '@google-cloud/recaptcha-enterprise';
import { env } from '~/env/server';
import { isDev } from '../../env/other';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { isDefined } from '~/utils/type-guards';
import * as z from 'zod';
import { logToAxiom } from '~/server/logging/client';
import { fetchTimeoutSignal } from '~/server/utils/fetch-timeout';

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

/**
 * Shape of a Turnstile `siteverify` response.
 *
 * This schema is EXECUTED (`safeParse`) against the response body — it used to be
 * declared and then bypassed by an `as`-cast, which made it decorative: a changed
 * or malformed upstream body flowed through with a fabricated type, and a
 * non-boolean `success` (e.g. the string `"true"`) read as truthy.
 *
 * It is deliberately TOLERANT, because it sits on the buzz-purchase payment paths
 * and a schema that is stricter than the wire format would convert benign upstream
 * drift into a 100% denial:
 *   - `looseObject` (not `object`) so fields Cloudflare adds later SURVIVE into the
 *     failure telemetry instead of being silently stripped — a new field is most
 *     useful precisely when we are trying to diagnose a change in behaviour.
 *   - every field except `success` carries `.catch(...)`, so an unexpected type on a
 *     purely INFORMATIONAL field degrades to a fallback rather than failing the
 *     verification. None of these fields gates anything.
 *   - `error-codes` in particular is only shown in Cloudflare's examples, not
 *     contractually guaranteed on every response, and it was never validated
 *     before — so it defaults to `[]` rather than being required.
 *
 * `success` is therefore the ONLY field that can fail the parse. A body that fails
 * it is not a siteverify response at all (an HTML interstitial, an empty body, a
 * proxy error page), and that is failed CLOSED with telemetry rather than guessed at.
 */
type SiteVerifyResponse = z.infer<typeof siteVerifyResponseSchema>;
const siteVerifyResponseSchema = z.looseObject({
  success: z.boolean(),
  challenge_ts: z.coerce.date().optional().catch(undefined),
  hostname: z.string().optional().catch(undefined),
  'error-codes': z.array(z.string()).catch([]),
  action: z.string().optional().catch(undefined),
  cdata: z.string().optional().catch(undefined),
  // Enterprise-only, absent on standard accounts. `looseObject` again so any
  // additional metadata Cloudflare ships alongside `ephemeral_id` survives.
  metadata: z.looseObject({ ephemeral_id: z.string().optional() }).optional().catch(undefined),
});

type CaptchaMeta = {
  source?: string;
  userId?: number;
  tokenAgeMs?: number;
  submitAttempt?: number;
  widgetStatus?: string;
  tokenPrefix?: string;
  pageSessionId?: string;
};

export async function verifyCaptchaToken({
  token,
  secret = env.CF_INVISIBLE_TURNSTILE_SECRET || env.CLOUDFLARE_TURNSTILE_SECRET,
  ip,
  meta,
}: {
  token: string;
  secret?: string;
  ip?: string;
  meta?: CaptchaMeta;
}) {
  const tokenPrefix = token.slice(0, 8);
  const startedAt = Date.now();
  const result = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret,
      response: token,
      remoteip: ip,
    }),
    signal: fetchTimeoutSignal(30_000),
  });
  const verifyLatencyMs = Date.now() - startedAt;
  const cfRay = result.headers.get('cf-ray') ?? undefined;
  if (!result.ok) {
    logToAxiom({
      name: 'captcha-failure',
      type: 'error',
      error: {
        reason: 'siteverify-not-ok',
        status: result.status,
        tokenPrefix,
        verifyLatencyMs,
        cfRay,
        ip,
        meta,
      },
    }, 'civitai-prod').catch(() => undefined);
    throw throwBadRequestError('No response from captcha service');
  }

  // A non-JSON body (HTML interstitial, empty body, truncated payload) lands in
  // the same malformed-response path below rather than escaping as a bare
  // SyntaxError with no telemetry attached.
  const rawBody = await result.json().catch(() => undefined);
  const parsed = siteVerifyResponseSchema.safeParse(rawBody);
  if (!parsed.success) {
    logToAxiom({
      name: 'captcha-failure',
      type: 'error',
      error: {
        reason: 'siteverify-malformed-response',
        // Compact, bounded issue list: names the field that drifted, which is the
        // whole diagnostic value. The raw body is deliberately NOT logged — it is
        // unbounded third-party content.
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          code: issue.code,
          message: issue.message,
        })),
        tokenPrefix,
        verifyLatencyMs,
        cfRay,
        ip,
        meta,
      },
    }, 'civitai-prod').catch(() => undefined);
    // Fail CLOSED. An unidentifiable response must not be able to authorise a
    // purchase, and the caller-visible error is the existing one, so this does
    // not introduce a new failure class for callers to handle.
    throw throwBadRequestError('Unable to verify captcha token');
  }

  const outcome: SiteVerifyResponse = parsed.data;
  if (outcome.success) {
    if (Math.random() < 0.01) {
      logToAxiom({
        name: 'captcha-success-sample',
        type: 'info',
        error: {
          tokenPrefix,
          verifyLatencyMs,
          cfRay,
          challenge_ts: outcome.challenge_ts,
          hostname: outcome.hostname,
          action: outcome.action,
          meta,
        },
      }, 'civitai-prod').catch(() => undefined);
    }
    return true;
  }

  logToAxiom({
    name: 'captcha-failure',
    type: 'error',
    error: {
      response: outcome,
      // Turnstile's device-fingerprint id (Enterprise only, absent otherwise).
      // Promoted to a first-class field because it is the natural correlation key
      // across failures from one device — reading it off the nested `response`
      // blob requires knowing it is there. Typed by the schema's `metadata`
      // declaration: drop that declaration and this line stops compiling.
      ephemeralId: outcome.metadata?.ephemeral_id,
      tokenPrefix,
      verifyLatencyMs,
      cfRay,
      // Recorded on FAILURE only. The success path (including its 1% sample above)
      // deliberately omits it: a per-request address on every successful
      // verification is PII volume for no diagnostic gain.
      ip,
      meta,
    },
  }, 'civitai-prod').catch(() => undefined);
  throw throwBadRequestError('Unable to verify captcha token');
}
