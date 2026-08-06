import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

import type * as LoggingClient from '~/server/logging/client';

/**
 * `verifyCaptchaToken` — siteverify request shape, response VALIDATION, and the
 * failure telemetry contract.
 *
 * Two properties are pinned here that the pre-change code did not have:
 *
 *  1. The siteverify response body is actually PARSED (it used to be `as`-cast,
 *     so `siteVerifyResponseSchema` was decorative and a changed upstream shape
 *     flowed through untyped). Parsing is deliberately TOLERANT — unknown fields
 *     survive, `error-codes` may be absent — so that benign upstream drift cannot
 *     turn into a hard denial on a payment path. What remains unparseable is
 *     failed CLOSED, with telemetry.
 *
 *  2. The failure telemetry carries the submitted `ip` and the caller's `meta`,
 *     and the SUCCESS telemetry carries neither ip nor any per-request address —
 *     logging it on success is per-request PII volume for no diagnostic gain.
 *
 * The negative assertion in "does NOT record the ip on success" is the one that
 * has to name the field explicitly; a test that only checks the failure logs
 * would pass with the ip leaking into every sampled success.
 */

// The Google reCAPTCHA Enterprise SDK is imported at client.ts module scope but
// serves only `createRecaptchaAssesment`; `verifyCaptchaToken` never touches it.
// Stub it so this suite doesn't construct a real gRPC client at import.
vi.mock('@google-cloud/recaptcha-enterprise', () => ({
  RecaptchaEnterpriseServiceClient: class {
    projectPath() {
      return 'projects/test';
    }
    async createAssessment() {
      return [undefined];
    }
  },
  v1: {},
}));

// `fetchTimeoutSignal` reaches the Flipt client to read a default-OFF flag. The
// timeout is orthogonal to everything asserted here, so pin it to its production
// default (no signal) rather than booting Flipt.
vi.mock('~/server/utils/fetch-timeout', () => ({
  fetchTimeoutSignal: () => undefined,
}));

import { logToAxiom } from '~/server/logging/client';
import { verifyCaptchaToken } from '~/server/recaptcha/client';

// The global setup mocks `~/server/logging/client` wholesale (it exports only
// `logToAxiom`), so the REAL classifier has to be pulled in via `importActual` —
// the same approach `src/server/logging/central-error-log.test.ts` uses. The
// override registry it consults (`server-fault-override.ts`) is NOT mocked, so the
// marking done inside `verifyCaptchaToken` is visible to this copy.
const { classifyErrorFault, buildCentralErrorLog } = await vi.importActual<typeof LoggingClient>(
  '~/server/logging/client'
);

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TOKEN = 'tok_abcdefghijklmnopqrstuvwxyz';
const TOKEN_PREFIX = TOKEN.slice(0, 8);
const SECRET = 'test-turnstile-secret';
const IP = '203.0.113.7';
const META = { source: 'test-source', userId: 4242 } as const;

type FetchStub = {
  ok?: boolean;
  status?: number;
  /** Response body returned by `.json()`. Ignored when `jsonThrows` is set. */
  body?: unknown;
  /** Simulate a non-JSON body (HTML error page, empty body, truncated payload). */
  jsonThrows?: boolean;
  cfRay?: string | null;
};

function stubSiteverify({
  ok = true,
  status = 200,
  body,
  jsonThrows,
  cfRay = 'ray-abc',
}: FetchStub) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status,
    headers: { get: (h: string) => (h.toLowerCase() === 'cf-ray' ? cfRay : null) },
    json: jsonThrows
      ? async () => {
          throw new SyntaxError('Unexpected token < in JSON at position 0');
        }
      : async () => body,
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

type AxiomPayload = {
  name?: string;
  type?: string;
  error?: Record<string, unknown>;
};

const axiomPayloads = (): AxiomPayload[] =>
  vi.mocked(logToAxiom).mock.calls.map(([payload]) => payload as AxiomPayload);

const logsNamed = (name: string) => axiomPayloads().filter((p) => p?.name === name);

/** The single `captcha-failure` payload, asserted to be unique so a test can't
 *  accidentally read a neighbouring log's fields. */
function soleFailureLog(): Record<string, unknown> {
  const failures = logsNamed('captcha-failure');
  expect(failures).toHaveLength(1);
  return failures[0].error as Record<string, unknown>;
}

const call = (overrides: Partial<Parameters<typeof verifyCaptchaToken>[0]> = {}) =>
  verifyCaptchaToken({ token: TOKEN, secret: SECRET, ip: IP, meta: { ...META }, ...overrides });

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('verifyCaptchaToken — siteverify request', () => {
  it('POSTs secret, response and remoteip to the Turnstile siteverify endpoint', async () => {
    const fetchMock = stubSiteverify({ body: { success: true, 'error-codes': [] } });

    await expect(call()).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(SITEVERIFY_URL);
    expect(init.method).toBe('POST');

    // The three body fields are the whole contract with Cloudflare. Asserted by
    // value, not just presence, so a swapped/renamed field is caught.
    const sent = JSON.parse(init.body as string);
    expect(sent).toMatchObject({ secret: SECRET, response: TOKEN, remoteip: IP });
    expect(sent.secret).toBe(SECRET);
    expect(sent.response).toBe(TOKEN);
    expect(sent.remoteip).toBe(IP);
  });
});

describe('verifyCaptchaToken — success', () => {
  it('resolves true and logs no failure', async () => {
    stubSiteverify({ body: { success: true, 'error-codes': [], hostname: 'civitai.com' } });

    await expect(call()).resolves.toBe(true);
    expect(logsNamed('captcha-failure')).toHaveLength(0);
  });

  it('does NOT record the ip on success, even when the 1% sample fires', async () => {
    // Force the sampled branch — otherwise this assertion is vacuous 99% of runs.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    stubSiteverify({
      body: { success: true, 'error-codes': [], hostname: 'civitai.com', action: 'buzz' },
    });

    await expect(call()).resolves.toBe(true);

    const samples = logsNamed('captcha-success-sample');
    // Positive control: the sampled log MUST have been emitted, otherwise the
    // "ip is absent" assertion below would pass against an empty array — a zero
    // indistinguishable from a probe wired to nothing.
    expect(samples).toHaveLength(1);
    const logged = samples[0].error as Record<string, unknown>;
    expect(logged.tokenPrefix).toBe(TOKEN_PREFIX);

    // The actual guard, naming the field — under BOTH the old and the current
    // name, so a later rename cannot quietly reintroduce the leak past a guard
    // that is still spelled for the previous field.
    expect(logged).not.toHaveProperty('ip');
    expect(logged).not.toHaveProperty('clientReportedIp');
    expect(Object.values(logged)).not.toContain(IP);
    expect(JSON.stringify(samples[0])).not.toContain(IP);
  });

  it('keeps challenge_ts as the raw upstream string rather than coercing it to a Date', async () => {
    // The success path is telemetry-neutral by construction: every field is read
    // straight back out into a log payload, so it stays in the representation
    // Cloudflare sent. Coercing to a `Date` is invisible in production (both
    // JSON-serialize to the same ISO-8601) but changes what the non-prod
    // `console.log` branch prints — a difference that only ever shows up on a
    // developer's machine, which is the worst place to discover it.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const CHALLENGE_TS = '2026-08-06T12:34:56.000Z';
    stubSiteverify({ body: { success: true, challenge_ts: CHALLENGE_TS } });

    await expect(call()).resolves.toBe(true);

    const samples = logsNamed('captcha-success-sample');
    expect(samples).toHaveLength(1);
    const logged = samples[0].error as Record<string, unknown>;
    expect(logged.challenge_ts).toBe(CHALLENGE_TS);
    expect(typeof logged.challenge_ts).toBe('string');
    expect(logged.challenge_ts).not.toBeInstanceOf(Date);
  });
});

describe('verifyCaptchaToken — failure telemetry carries ip and meta', () => {
  it('records the submitted ip and the caller meta when siteverify rejects the token', async () => {
    stubSiteverify({
      body: { success: false, 'error-codes': ['invalid-input-response'] },
    });

    await expect(call()).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const logged = soleFailureLog();
    expect(logged.clientReportedIp).toBe(IP);
    expect(logged.meta).toEqual(META);
    expect(logged.tokenPrefix).toBe(TOKEN_PREFIX);
    expect(logged.cfRay).toBe('ray-abc');
    expect(logged.response).toMatchObject({ success: false });
  });

  it('records the submitted ip and the caller meta when siteverify returns a non-OK status', async () => {
    stubSiteverify({ ok: false, status: 503, body: undefined });

    await expect(call()).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const logged = soleFailureLog();
    expect(logged.reason).toBe('siteverify-not-ok');
    expect(logged.status).toBe(503);
    expect(logged.clientReportedIp).toBe(IP);
    expect(logged.meta).toEqual(META);
  });
});

describe('verifyCaptchaToken — response schema is EXECUTED', () => {
  it('fails closed, with telemetry, on a body that is not a siteverify response', async () => {
    // `success` missing entirely — the one field the schema requires. Pre-change
    // this was `as`-cast, so `outcome.success` read `undefined` and the call fell
    // through to the generic failure path with no signal that the SHAPE was wrong.
    stubSiteverify({ body: { unexpected: 'payload' } });

    await expect(call()).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const logged = soleFailureLog();
    expect(logged.reason).toBe('siteverify-malformed-response');
    expect(logged.clientReportedIp).toBe(IP);
    expect(logged.meta).toEqual(META);
    // The parse issues are the diagnostic payload — they name the field that drifted.
    expect(Array.isArray(logged.issues)).toBe(true);
    expect(JSON.stringify(logged.issues)).toContain('success');
  });

  it('fails closed, with telemetry, on a non-JSON body', async () => {
    // A 200 carrying an HTML interstitial / empty body. Pre-change the bare
    // `await result.json()` threw a raw SyntaxError with no telemetry at all.
    stubSiteverify({ jsonThrows: true });

    await expect(call()).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const logged = soleFailureLog();
    expect(logged.reason).toBe('siteverify-malformed-response');
    expect(logged.clientReportedIp).toBe(IP);
    expect(logged.meta).toEqual(META);
  });

  it('never resolves true on a malformed body carrying success:true', async () => {
    // Fail-CLOSED direction, stated as its own guard: an unparseable body must
    // not be able to authorise anything, even if it happens to contain a truthy
    // `success`. Here `success` is the wrong TYPE, which is exactly what an
    // `as`-cast would have waved through.
    stubSiteverify({ body: { success: 'true', 'error-codes': [] } });

    await expect(call()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(soleFailureLog().reason).toBe('siteverify-malformed-response');
  });
});

describe('verifyCaptchaToken — the schema stays TOLERANT of benign upstream drift', () => {
  it('accepts a success body with no error-codes field', async () => {
    // `error-codes` is shown in Cloudflare's examples but is not contractually
    // guaranteed on every response, and it was never validated before. Requiring
    // it would convert a benign omission into a 100% denial on the payment paths.
    stubSiteverify({ body: { success: true } });

    await expect(call()).resolves.toBe(true);
    expect(logsNamed('captcha-failure')).toHaveLength(0);
  });

  it('accepts, and does not strip, fields Cloudflare adds later', async () => {
    stubSiteverify({
      body: {
        success: false,
        'error-codes': ['timeout-or-duplicate'],
        some_future_field: { nested: 'value' },
      },
    });

    await expect(call()).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const logged = soleFailureLog();
    expect(logged.reason).not.toBe('siteverify-malformed-response');
    // Survived the parse rather than being stripped — otherwise a new upstream
    // field is invisible in telemetry exactly when we need it to diagnose.
    expect(logged.response).toMatchObject({ some_future_field: { nested: 'value' } });
  });

  it('preserves metadata.ephemeral_id through the parse and promotes it to a first-class log field', async () => {
    stubSiteverify({
      body: {
        success: false,
        'error-codes': ['invalid-input-response'],
        metadata: { ephemeral_id: 'x:9f78e0ed210960d7693b167e' },
      },
    });

    await expect(call()).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const logged = soleFailureLog();
    // Survives the parse...
    const response = logged.response as { metadata?: { ephemeral_id?: string } };
    expect(response.metadata?.ephemeral_id).toBe('x:9f78e0ed210960d7693b167e');
    // ...and is readable without digging into the nested response blob.
    expect(logged.ephemeralId).toBe('x:9f78e0ed210960d7693b167e');
  });

  it('hands every parse its OWN error-codes fallback array', async () => {
    // `.catch([])` stores ONE array literal and returns that same reference from
    // every parse, so mutating one verification's result would poison every later
    // one process-wide — cross-request shared mutable state on a payment path.
    // `.catch(() => [])` builds a fresh array per parse. Nothing mutates this today;
    // the guard is here because the failure mode is silent and permanent if it does.
    const bodyWithoutErrorCodes = { success: false };

    stubSiteverify({ body: bodyWithoutErrorCodes });
    await expect(call()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const first = (soleFailureLog().response as Record<string, unknown>)['error-codes'] as string[];
    expect(first).toEqual([]);

    // Poison the first result, then verify again.
    first.push('POISONED-BY-A-PREVIOUS-REQUEST');
    vi.clearAllMocks();

    stubSiteverify({ body: bodyWithoutErrorCodes });
    await expect(call()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const second = (soleFailureLog().response as Record<string, unknown>)[
      'error-codes'
    ] as string[];

    // The assertion that fails under `.catch([])`.
    expect(second).toEqual([]);
    expect(second).not.toContain('POISONED-BY-A-PREVIOUS-REQUEST');
    expect(second).not.toBe(first);
  });

  it('leaves ephemeralId undefined when Cloudflare sends no metadata', async () => {
    // The standard (non-Enterprise) response. Negative control for the test
    // above: proves `ephemeralId` tracks the payload rather than being a
    // constant that would satisfy the assertion either way.
    stubSiteverify({ body: { success: false, 'error-codes': ['invalid-input-response'] } });

    await expect(call()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(soleFailureLog().ephemeralId).toBeUndefined();
  });
});

describe('verifyCaptchaToken — the raw upstream body is never logged', () => {
  it('logs the parse issues but not the body that produced them', async () => {
    // The malformed-response log deliberately carries only a bounded issue list.
    // The body is unbounded third-party content: it can be an HTML error page of
    // arbitrary size, and on this path it is attacker-influenced only insofar as
    // Cloudflare is compromised — but the size argument alone is enough.
    //
    // Without this test the comment claiming the body is "deliberately NOT logged"
    // was unguarded: adding `rawBody` to the payload left all tests green.
    const SENTINEL = 'SENTINEL-RAW-BODY-MUST-NOT-BE-LOGGED';
    stubSiteverify({ body: { unexpected: SENTINEL } });

    await expect(call()).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const failures = logsNamed('captcha-failure');
    expect(failures).toHaveLength(1);
    const logged = failures[0].error as Record<string, unknown>;

    // Positive control: the log DID happen and DID carry its diagnostic payload,
    // so the absence assertions below are not passing against an empty object.
    expect(logged.reason).toBe('siteverify-malformed-response');
    expect(JSON.stringify(logged.issues)).toContain('success');

    // The guards, by field name and by value.
    expect(logged).not.toHaveProperty('rawBody');
    expect(logged).not.toHaveProperty('body');
    expect(logged).not.toHaveProperty('response');
    expect(JSON.stringify(failures[0])).not.toContain(SENTINEL);
  });
});

/**
 * Item 1 of the audit: severity, not status.
 *
 * An unusable UPSTREAM response and a genuinely failed verification both answer the
 * caller BAD_REQUEST/400, but they are not the same kind of event:
 *
 *   - upstream unusable  → nobody did anything wrong; it is an incident, and if
 *     Cloudflare starts serving interstitials EVERY buzz purchase fails. It has to
 *     reach the error stream.
 *   - verification failed → routine client feedback (stale/replayed/forged token).
 *     Promoting these to error severity would bury the case above in noise.
 *
 * These assert on the SEVERITY the central tRPC chokepoint would emit
 * (`buildCentralErrorLog(...).type` — the field the Alloy→Loki pipeline reads as
 * `detected_level`), for the error each path actually throws. The pair is the point:
 * either assertion alone would pass under a change that flattened both to one value.
 */
describe('verifyCaptchaToken — upstream faults are SERVER faults, failed verifications are not', () => {
  async function thrownError(stub: Parameters<typeof stubSiteverify>[0]): Promise<unknown> {
    stubSiteverify(stub);
    try {
      await call();
    } catch (e) {
      return e;
    }
    throw new Error('expected verifyCaptchaToken to reject, but it resolved');
  }

  it('classifies a malformed upstream response as a SERVER fault logged at type:error', async () => {
    const error = await thrownError({ body: { unexpected: 'payload' } });

    // Status is unchanged — this is a severity fix, not a status change.
    expect(error).toMatchObject({ code: 'BAD_REQUEST' });
    expect(classifyErrorFault(error)).toBe('server');
    expect(buildCentralErrorLog(error).type).toBe('error');
  });

  it('classifies a non-JSON upstream body as a SERVER fault logged at type:error', async () => {
    const error = await thrownError({ jsonThrows: true });

    expect(error).toMatchObject({ code: 'BAD_REQUEST' });
    expect(classifyErrorFault(error)).toBe('server');
    expect(buildCentralErrorLog(error).type).toBe('error');
  });

  it('classifies a non-OK upstream status as a SERVER fault logged at type:error', async () => {
    const error = await thrownError({ ok: false, status: 503 });

    expect(error).toMatchObject({ code: 'BAD_REQUEST' });
    expect(classifyErrorFault(error)).toBe('server');
    expect(buildCentralErrorLog(error).type).toBe('error');
  });

  it('leaves a genuinely failed verification a CLIENT fault logged at type:info', async () => {
    // The asymmetry guard. A user submitting a stale or forged token is not an
    // incident, and this must NOT have been swept up by the change above.
    const error = await thrownError({
      body: { success: false, 'error-codes': ['timeout-or-duplicate'] },
    });

    expect(error).toMatchObject({ code: 'BAD_REQUEST' });
    expect(classifyErrorFault(error)).toBe('client');
    expect(buildCentralErrorLog(error).type).toBe('info');
  });

  it('does not mark unrelated BAD_REQUESTs as server faults', async () => {
    // Negative control on the override registry itself: it must be per-error, not
    // a global switch that reclassifies every BAD_REQUEST once a captcha fails.
    await thrownError({ body: { unexpected: 'payload' } });

    const unrelated = new TRPCError({ code: 'BAD_REQUEST', message: 'unrelated' });
    expect(classifyErrorFault(unrelated)).toBe('client');
    expect(buildCentralErrorLog(unrelated).type).toBe('info');
  });
});
