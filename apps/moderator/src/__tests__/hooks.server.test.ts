import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * CREDENTIAL ATTRIBUTION AT THE INGRESS.
 *
 * `hooks.server.ts` is the only place a verified inbound service credential is turned into request
 * state, so it is the only place that can record WHICH credential class authenticated. That record is
 * the runtime signal the WEBHOOK_TOKEN removal is graded on (see the header of
 * `$lib/server/webhook-endpoint`), which makes these behavioural guards, not logging cosmetics:
 *
 *   - BOTH classes emit. A legacy-only emitter would make a zero unfalsifiable.
 *   - The record carries NOTHING derived from the token's bytes.
 *   - `locals.tokenClient` is still exactly `'webhook'`, for both classes. Three call sites compare
 *     that field strictly; widening it would 401 every token-authenticated request with no type error.
 *   - A refused credential records nothing.
 *   - A logging fault never becomes a failed request.
 *
 * Three modules are replaced at load. Each is named with why, because a wholesale module mock is how a
 * suite goes green against a module that has since grown an export it needs:
 *   `$lib/server/page-access` — transitively imports `$lib/server/db`, which demands DATABASE_URL and
 *     DATABASE_REPLICA_URL at MODULE SCOPE. The moderator vitest config withholds the replica URL on
 *     purpose, so importing the hook for real throws before any test runs. Only `loadPageAccessGrants`
 *     is reachable from the hook.
 *   `$lib/server/auth` — its `guard` opens a session client at module scope and would make a network
 *     call on the session path. Only `guard.check` is reachable from the hook.
 *   `$lib/server/axiom` — the surface under assertion. Both exports the hook imports are replaced.
 *
 * `$lib/server/webhook-endpoint` is deliberately NOT mocked: the credential the record carries comes
 * from the real comparison against real env values, so these tests fail if attribution is wired to a
 * constant.
 */

type Emitted = Record<string, unknown>;

// The parameter types are declared rather than inferred: `vi.fn(async () => …)` infers an EMPTY
// argument tuple, so `mock.calls[n][0]` is then `undefined` at the type level and every assertion on
// the emitted record silently reads nothing.
const { loadPageAccessGrants, guardCheck, logToAxiom, logAxiomError } = vi.hoisted(() => ({
  loadPageAccessGrants: vi.fn(async () => ({})),
  guardCheck: vi.fn(async (_cookieHeader: string, _returnUrl: string) => ({} as unknown)),
  logToAxiom: vi.fn(async (_data: Emitted, _datastream?: string) => undefined as unknown),
  logAxiomError: vi.fn(async (_error: unknown, _extra?: Emitted) => undefined as unknown),
}));

vi.mock('$lib/server/page-access', () => ({ loadPageAccessGrants }));
vi.mock('$lib/server/auth', () => ({ guard: { check: guardCheck } }));
vi.mock('$lib/server/axiom', () => ({
  logToAxiom,
  logAxiomError,
  safeError: (e: unknown) => ({ e }),
}));

const { handle, CREDENTIAL_ATTRIBUTION_EVENT } = await import('../hooks.server');

/**
 * Fixture values, chosen pairwise distinct and distinct from every constant an assertion below names —
 * neither secret spells a credential class, the path is not `/api/`, the method is not the `GET` a
 * bare `new Request()` would default to, and the user-agent is not a substring of anything else. A
 * fixture that can only ever produce the value an assertion hardcodes cannot see a hardcode mutant.
 */
const INBOUND_SECRET = 'sk-inbound-9f31c2';
const LEGACY_SECRET = 'sk-legacy-4a70de';
const PATH = '/api/mod/abuse-report';
const METHOD = 'PATCH';
const USER_AGENT = 'civitai-web/2026.08 (delegated-moderation)';

function eventFor(options: { query?: string; authorization?: string; path?: string }) {
  const url = new URL(`https://moderator.civitai.com${options.path ?? PATH}`);
  if (options.query !== undefined) url.searchParams.set('token', options.query);
  const headers = new Headers({ 'user-agent': USER_AGENT });
  if (options.authorization !== undefined) headers.set('authorization', options.authorization);
  return {
    url,
    request: new Request(url, { method: METHOD, headers }),
    locals: {} as Record<string, unknown>,
    route: { id: PATH },
  };
}

/** Runs the hook with a resolve() that reports whether it was reached. */
async function run(event: ReturnType<typeof eventFor>) {
  // 204 marks "the handler ran", and is distinct from every status the hook itself can produce (302
  // login, 303 forbidden/denied, 401 refused, 503 unconfigured) so a test can tell them apart. Null
  // body because the Response constructor rejects a body on a 204.
  const resolve = vi.fn(async () => new Response(null, { status: 204 }));
  // The hook's real signature carries SvelteKit internals no test constructs; the shape above is
  // everything this code path reads.
  const response = await (handle as unknown as (arg: unknown) => Promise<Response>)({
    event,
    resolve,
  });
  return { response, resolve };
}

const emitted = (): Emitted[] => logToAxiom.mock.calls.map((call) => call[0] as Emitted);

function setEnv(vars: { WEBHOOK_TOKEN?: string; MOD_INBOUND_TOKEN?: string }) {
  delete process.env.WEBHOOK_TOKEN;
  delete process.env.MOD_INBOUND_TOKEN;
  if (vars.WEBHOOK_TOKEN !== undefined) process.env.WEBHOOK_TOKEN = vars.WEBHOOK_TOKEN;
  if (vars.MOD_INBOUND_TOKEN !== undefined) process.env.MOD_INBOUND_TOKEN = vars.MOD_INBOUND_TOKEN;
}

const saved = {
  WEBHOOK_TOKEN: process.env.WEBHOOK_TOKEN,
  MOD_INBOUND_TOKEN: process.env.MOD_INBOUND_TOKEN,
};

/**
 * Every test owns its own reset — no `vi.resetModules()`, and nothing here depends on the order the
 * file runs in. Prove it with `--sequence.shuffle` rather than trusting the arrangement.
 */
beforeEach(() => {
  logToAxiom.mockReset();
  logToAxiom.mockResolvedValue(undefined);
  logAxiomError.mockReset();
  guardCheck.mockReset();
  guardCheck.mockResolvedValue({ status: 'login', redirect: 'https://auth.example/login' });
  setEnv({ MOD_INBOUND_TOKEN: INBOUND_SECRET, WEBHOOK_TOKEN: LEGACY_SECRET });
});
afterEach(() => setEnv(saved));

describe('inbound credential attribution', () => {
  it('records MOD_INBOUND_TOKEN, with exactly the fields the migration read needs and nothing else', async () => {
    const { resolve } = await run(eventFor({ query: INBOUND_SECRET }));

    expect(resolve).toHaveBeenCalledTimes(1);
    // An EXACT match, not a `toMatchObject`: the strongest available guard against a future edit
    // adding a token prefix, length or hash to the record. Any extra key fails here.
    expect(emitted()).toEqual([
      {
        type: 'info',
        event: CREDENTIAL_ATTRIBUTION_EVENT,
        credential: 'MOD_INBOUND_TOKEN',
        path: PATH,
        method: METHOD,
        userAgent: USER_AGENT,
      },
    ]);
  });

  it('🔴 the RETIRED credential emits NOTHING — so a zero for it is a real zero, not a filtered one', async () => {
    // The retired class must contribute no attribution records at all. If a refused credential still
    // emitted, its count could never fall to zero and would read as ongoing use forever — the signal
    // this whole mechanism exists to provide would be permanently stuck. `beforeEach` still SETS the
    // variable (four outbound callers need it), so this is a statement about the accepted set.
    await run(eventFor({ query: LEGACY_SECRET }));
    expect(emitted()).toEqual([]);
  });

  // 🔴 DORMANT: 'BOTH classes emit from one deployment — the zero is only evidence beside a live
  // control'. It needs two ACCEPTED classes and cannot be written at one. The property it pinned is
  // the reason the emit covers every accepted class rather than just a retiring one: a non-zero count
  // for a live class is the in-band positive control proving the emit path was live at the moment a
  // retiring class's count read zero. Restore it if a second class is added — asserted as a SET of
  // classes, so it cannot be satisfied by two lines naming the same one.

  it('attributes a Bearer-presented credential the same as a query-presented one', async () => {
    await run(eventFor({ authorization: `Bearer ${INBOUND_SECRET}` }));
    expect(emitted()).toHaveLength(1);
    expect(emitted()[0].credential).toBe('MOD_INBOUND_TOKEN');
  });

  it('🔴 carries NOTHING derived from the token bytes, even when the token is in the URL', async () => {
    // `?token=` is how the main app calls in, so `url.href`/`url.search` would put the live secret on
    // a log stream far more readable than the secret store. `pathname` is what keeps it out.
    //
    // 🔴 Driven with the ACCEPTED secret deliberately. Presenting the retired one emits nothing, so
    // every assertion below would run against an EMPTY array and pass without testing anything — a
    // vacuous green on the one test here that guards a secret.
    await run(eventFor({ query: INBOUND_SECRET }));
    expect(emitted()).toHaveLength(1); // the record exists, so the assertions below have a subject
    const serialized = JSON.stringify(emitted());
    expect(serialized).not.toContain(INBOUND_SECRET);
    // …and no PREFIX of it either, which is what a "just the first few characters for correlation"
    // edit would add. Six characters past the shared `sk-` prefix is already an oracle.
    expect(serialized).not.toContain(INBOUND_SECRET.slice(0, 9));
    expect(serialized).not.toContain(String(INBOUND_SECRET.length));
  });
});

describe('what must NOT be recorded', () => {
  it('a REFUSED credential records nothing and never reaches a handler', async () => {
    const { response, resolve } = await run(eventFor({ query: 'not-a-configured-secret' }));
    expect(response.status).toBe(401);
    expect(resolve).not.toHaveBeenCalled();
    expect(logToAxiom).not.toHaveBeenCalled();
  });

  it('a request presenting NO credential falls through to the session guard and records nothing', async () => {
    const { response, resolve } = await run(eventFor({}));
    // The `none` verdict: the hook must not answer it, it must hand it to the session guard.
    expect(guardCheck).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(302);
    expect(resolve).not.toHaveBeenCalled();
    expect(logToAxiom).not.toHaveBeenCalled();
  });

  it('the 503 no-secret-configured path is unchanged, and records nothing', async () => {
    setEnv({});
    const { response, resolve } = await run(eventFor({ query: LEGACY_SECRET }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      message: 'MOD_INBOUND_TOKEN is not configured on this deployment.',
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(logToAxiom).not.toHaveBeenCalled();
  });

  it('a non-/api/ path is not treated as token ingress even when a token is presented', async () => {
    const { response } = await run(eventFor({ query: INBOUND_SECRET, path: '/reports/abc' }));
    expect(guardCheck).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(302);
    expect(logToAxiom).not.toHaveBeenCalled();
  });
});

describe('locals.tokenClient stays exactly "webhook"', () => {
  /**
   * The regression guard for the three strict consumers — `WebhookEndpoint` and
   * `defineWebhookEndpoint` compare `!== 'webhook'`, `defineEndpoint` reads it for truthiness. The
   * obvious way to expose the credential class is to widen this field; doing so refuses every
   * token-authenticated request at all three sites, with no type error to catch it.
   *
   * `toBe` on the literal, not a truthiness check: `'webhook:legacy'` is truthy too.
   */
  it('for MOD_INBOUND_TOKEN', async () => {
    const event = eventFor({ query: INBOUND_SECRET });
    await run(event);
    expect(event.locals.tokenClient).toBe('webhook');
  });

  it('and is NOT set for the retired credential, which never authenticates', async () => {
    // The mirror of the case above. A refused credential must leave `tokenClient` unset, so nothing
    // downstream can treat a retired token as a webhook caller — `WebhookEndpoint` and
    // `defineWebhookEndpoint` gate on this field, and a stale `'webhook'` here would wave it through.
    const event = eventFor({ query: LEGACY_SECRET });
    await run(event);
    expect(event.locals.tokenClient).toBeUndefined();
  });

  it('and grants are emptied on token ingress, so nothing reached this way inherits a permission', async () => {
    const event = eventFor({ query: INBOUND_SECRET });
    await run(event);
    expect(event.locals.grants).toEqual({});
    expect(event.locals.user).toBeUndefined();
  });
});

describe('attribution never breaks a request', () => {
  it('ATTACHES a rejection handler to the emit — a logger that REJECTS must not surface anywhere', async () => {
    // 🔴 The behavioural half of this (request still 204) passes with the `.catch()` DELETED, because
    // an unhandled rejection inside a vitest worker is reported out-of-band and does not fail the
    // request. Measured: removing `.catch(() => {})` left this file fully green. In the server it is
    // not benign — Node's default `--unhandled-rejections=throw` terminates the process, so the
    // deleted handler turns a logging blip into a pod restart.
    //
    // So the assertion is on the handler being attached, observed on the very promise the hook is
    // handed. That IS the code path, not a word about it.
    const rejected = Promise.reject(new Error('axiom ingest refused'));
    const catchSpy = vi.spyOn(rejected, 'catch');
    logToAxiom.mockReturnValue(rejected);

    const { response, resolve } = await run(eventFor({ query: INBOUND_SECRET }));
    // Read BEFORE this test attaches its own handler below, or the count stops being about the hook.
    const attachedByHook = catchSpy.mock.calls.length;
    rejected.catch(() => {});

    expect(attachedByHook).toBe(1);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(204);
  });

  it('survives a logger that throws SYNCHRONOUSLY, which a bare .catch() would not', async () => {
    // The half a promise `.catch()` cannot cover: a throw on the way IN never produces a promise to
    // attach a handler to. Distinct from the rejecting case above, and it fails differently — the
    // throw propagates out of the hook and the request 500s.
    logToAxiom.mockImplementation(() => {
      throw new Error('logger constructed badly');
    });
    const { response, resolve } = await run(eventFor({ query: INBOUND_SECRET }));
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(204);
  });
});
