import { RecaptchaEnterpriseServiceClient, v1 } from '@google-cloud/recaptcha-enterprise';
import { TRPCError } from '@trpc/server';
import { env } from '~/env/server';
import { isDev } from '../../env/other';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { isDefined } from '~/utils/type-guards';
import * as z from 'zod';
import { logToAxiom } from '~/server/logging/client';
import { escalateToServerFault } from '~/server/logging/server-fault-override';
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
 *
 * 🔴 A `.catch(<literal>)` fallback must be a FACTORY (`.catch(() => [])`) whenever the
 * fallback is an object or array. Zod stores the literal and hands the SAME reference
 * to every parse, so one shared array/object would be live cross-request mutable state
 * on a payment path — mutate the result of one verification and every later one sees
 * it. Primitive fallbacks (`undefined` below) cannot alias, so they are written plainly.
 * Every non-primitive fallback in this schema must therefore be a factory; `error-codes`
 * is currently the only one.
 *
 * Field types are chosen to be TELEMETRY-NEUTRAL: these values are only ever read back
 * out into a log payload, so each is kept in the wire representation Cloudflare sent
 * (`challenge_ts` stays the raw ISO-8601 STRING rather than being coerced to a `Date`).
 * Coercion would be invisible in production, where the payload is JSON-serialized either
 * way, but would silently change what the non-prod `console.log` branch prints.
 */
type SiteVerifyResponse = z.infer<typeof siteVerifyResponseSchema>;
// Exported ONLY so the suite can enumerate `.shape` and enforce the tolerance rule
// above on every field — including fields that do not exist yet. A per-field test
// cannot see a field added tomorrow; iterating the shape can. Nothing else imports it.
export const siteVerifyResponseSchema = z.looseObject({
  success: z.boolean(),
  challenge_ts: z.string().optional().catch(undefined),
  hostname: z.string().optional().catch(undefined),
  'error-codes': z.array(z.string()).catch(() => []),
  action: z.string().optional().catch(undefined),
  cdata: z.string().optional().catch(undefined),
  // Enterprise-only, absent on standard accounts. `looseObject` again so any
  // additional metadata Cloudflare ships alongside `ephemeral_id` survives.
  metadata: z.looseObject({ ephemeral_id: z.string().optional() }).optional().catch(undefined),
});

/**
 * A verification that failed because the UPSTREAM (Turnstile) response was unusable —
 * a non-2xx status, or a body that is not a siteverify response at all.
 *
 * The caller still gets BAD_REQUEST/400: the request genuinely cannot be completed and
 * we fail closed, and keeping the status means no caller has a new failure class to
 * handle. But the ORIGIN of the fault is ours-and-upstream's, not the caller's — the
 * user submitted a perfectly good token and can do nothing differently. So the error is
 * escalated to a SERVER fault, which flips only the LOG SEVERITY (`type:'error'`) at the
 * central tRPC chokepoint, putting it in the `detected_level="error"` stream operators
 * actually watch.
 *
 * That asymmetry is deliberately NOT applied to a genuine failed verification
 * (`success:false`) further down. Be precise about what it does and does not change,
 * because there are TWO log lines per failure and the marking governs only one of them:
 *
 *   - The `captcha-failure` line this module emits directly is hardcoded `type:'error'`
 *     on EVERY failure path, genuine rejections included (see the log at the end of
 *     `verifyCaptchaToken`). Marking changes nothing about it.
 *   - The CENTRAL line the tRPC chokepoint emits derives its severity from
 *     `classifyErrorFault`. That is the only line marking moves.
 *
 * So leaving a genuine rejection unmarked is not about keeping it out of the error
 * stream — it is already there on the line above. It is about the central line
 * continuing to say what it is: a caller-side outcome, not a fault of ours. Marking it
 * would make the chokepoint attribute a routine rejection to the server, and the
 * chokepoint's severity is exactly the signal used to tell those two apart.
 *
 * NOTE: this keeps the 400, so `civitai_app_http_errors_total` still does not count it
 * (that counter is 5xx-only by construction). The error stream is the compensating
 * signal, and a sustained rise in error-level lines is already alerted on by signature —
 * getting these lines INTO that stream is exactly what this severity fix buys.
 *
 * Built with `new TRPCError` rather than `throwBadRequestError` because that helper
 * THROWS instead of returning, so its result cannot be marked before it propagates.
 * The constructed error is otherwise identical to what the helper produces.
 */
function upstreamFaultError(message: string): TRPCError {
  return escalateToServerFault(new TRPCError({ code: 'BAD_REQUEST', message }));
}

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
    logToAxiom(
      {
        name: 'captcha-failure',
        type: 'error',
        error: {
          reason: 'siteverify-not-ok',
          status: result.status,
          tokenPrefix,
          verifyLatencyMs,
          cfRay,
          // Client-supplied and unverified. Never treat this as forensic evidence,
          // and never use it to block, rate-limit, or attribute.
          clientReportedIp: ip,
          meta,
        },
      },
      'civitai-prod'
    ).catch(() => undefined);
    throw upstreamFaultError('No response from captcha service');
  }

  // A non-JSON body (HTML interstitial, empty body, truncated payload) lands in
  // the same malformed-response path below rather than escaping as a bare
  // SyntaxError with no telemetry attached.
  const rawBody = await result.json().catch(() => undefined);
  const parsed = siteVerifyResponseSchema.safeParse(rawBody);
  if (!parsed.success) {
    logToAxiom(
      {
        name: 'captcha-failure',
        type: 'error',
        error: {
          reason: 'siteverify-malformed-response',
          // Compact, bounded issue list: names the field that drifted, which is the
          // whole diagnostic value. The raw body is deliberately NOT logged — it is
          // unbounded third-party content. Pinned by the "does not log the raw
          // upstream body" test; adding it here turns that test red.
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            code: issue.code,
            message: issue.message,
          })),
          tokenPrefix,
          verifyLatencyMs,
          cfRay,
          // Client-supplied and unverified. Never treat this as forensic evidence,
          // and never use it to block, rate-limit, or attribute.
          clientReportedIp: ip,
          meta,
        },
      },
      'civitai-prod'
    ).catch(() => undefined);
    // Fail CLOSED. An unidentifiable response must not be able to authorise a
    // purchase, and the caller-visible error is the existing one, so this does
    // not introduce a new failure class for callers to handle.
    throw upstreamFaultError('Unable to verify captcha token');
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

  logToAxiom(
    {
      name: 'captcha-failure',
      type: 'error',
      error: {
        response: outcome,
        // Turnstile's device-fingerprint id (Enterprise only, absent otherwise).
        // Promoted to a first-class field because it is the natural correlation key
        // across failures from one device — reading it off the nested `response`
        // blob requires knowing it is there.
        //
        // The `metadata` declaration in the schema is what types this expression:
        // delete it and this line stops compiling. That guarantee is TYPE-LEVEL
        // ONLY and cannot be pinned by a runtime test — `looseObject` passes the
        // field through whether or not it is declared, so the value would still
        // arrive. Typecheck is the gate here, not the suite.
        ephemeralId: outcome.metadata?.ephemeral_id,
        tokenPrefix,
        verifyLatencyMs,
        cfRay,
        // Client-supplied and unverified. Never treat this as forensic evidence, and
        // never use it to block, rate-limit, or attribute.
        clientReportedIp: ip,
        meta,
      },
    },
    'civitai-prod'
  ).catch(() => undefined);
  throw throwBadRequestError('Unable to verify captcha token');
}
