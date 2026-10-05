import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `deleteAccount` — the spoke half of the moderator account-deletion path.
 *
 * Two properties it is easy to lose, and one of them is a decision rather than a bug:
 *
 *  - It must authenticate as the MODERATOR, by relaying their session cookie, not with the shared
 *    `WEBHOOK_TOKEN`. The two schemes are one argument apart in `postJson` and both "work", but only
 *    the session one tells the main app which moderator acted.
 *
 *  - 🔴 It must NOT write a `ModActivity` row. Most neighbours in `user-actions.service.ts` end
 *    with `logAction`, so adding one here looks like fixing an omission. It is not: `/api/mod/user/delete` writes its
 *    own row against `ctx.actor.id`, because a bearer-token script reaches that endpoint without
 *    passing through this app at all. `ModActivity` is append-only in production, so a `logAction`
 *    here is a SECOND row in the account history for one deletion, not a deduped one. The other end
 *    of the same decision is pinned in
 *    `src/__tests__/pages/api/mod/user/delete-audit-attribution.test.ts`.
 */

const recordModActivity = vi.hoisted(() => vi.fn(async () => undefined));
const recordModActivityBatch = vi.hoisted(() => vi.fn(async () => undefined));
const cookie = vi.hoisted(() => ({ value: 'civ-token=the-moderators-session' as string | null }));

vi.mock('$lib/server/db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  // A row, not an empty result: `purgeAllContent` — the control in "the audit row belongs to the
  // endpoint" — stops at its own existence check without one, and would then report "not logged"
  // for the wrong reason.
  const rows = [{ id: 8675309 }];
  return { dbRead: capturingDb([], rows), dbWrite: capturingDb([], rows) };
});
vi.mock('../mod-activity', () => ({ recordModActivity, recordModActivityBatch }));
vi.mock('$env/dynamic/private', () => ({
  env: { CIVITAI_APP_URL: 'https://civitai.com', WEBHOOK_TOKEN: 'shared-secret' },
}));
vi.mock('$app/server', () => ({
  getRequestEvent: () => ({
    locals: {},
    request: {
      headers: new Headers(cookie.value ? { cookie: cookie.value } : {}),
    },
  }),
}));

const { deleteAccount, purgeAllContent } = await import('../user-actions.service');

const TARGET = 8675309;
const MAY_HAVE_COMPLETED =
  'Account deletion could not be confirmed. It may already have completed — re-check the account before retrying.';

type Call = { url: string; init: RequestInit };
let calls: Call[];
let respond: () => Response;

beforeEach(() => {
  // First, so a test that stubs something other than `fetch` (the timeout-budget case stubs
  // `AbortSignal`) cannot leak it into the next one.
  vi.unstubAllGlobals();
  calls = [];
  cookie.value = 'civ-token=the-moderators-session';
  respond = () => new Response(JSON.stringify({ deleted: true, userId: TARGET }), { status: 200 });
  recordModActivity.mockClear();
  recordModActivityBatch.mockClear();
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(respond());
  });
});

const headerOf = (init: RequestInit, name: string) =>
  (init.headers as Record<string, string> | undefined)?.[name];

describe('deleteAccount — how it authenticates', () => {
  it('relays the moderator session cookie to /api/mod/user/delete', async () => {
    const result = await deleteAccount({ userId: TARGET });

    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://civitai.com/api/mod/user/delete');
    expect(headerOf(calls[0].init, 'cookie')).toBe('civ-token=the-moderators-session');
  });

  // The revert. `auth: 'webhook'` sends no cookie, and the main app would then have no idea which
  // moderator acted.
  it('does NOT fall back to the shared webhook token', async () => {
    await deleteAccount({ userId: TARGET });

    expect(calls[0].url).not.toContain('token=');
    expect(calls[0].url).not.toContain('shared-secret');
  });

  it('refuses rather than calling out at all when there is no session to forward', async () => {
    cookie.value = null;

    const result = await deleteAccount({ userId: TARGET });

    // One of the few failures that may honestly be called a failure: nothing was attempted.
    expect(result).toEqual({
      ok: false,
      error: 'Account deletion failed: no session to forward.',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('deleteAccount — what it sends', () => {
  it('sends the id alone when neither removal option was chosen', async () => {
    await deleteAccount({ userId: TARGET });

    // Not `removeImages: undefined` on the wire. The endpoint defaults an absent value to `false`
    // (grace), so absent and `false` agree — but `true` still means immediate and irrecoverable,
    // and an explicit `false` must never be flattened into absence by a future edit.
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ userId: TARGET });
  });

  it('sends an explicit false rather than flattening it into absence', async () => {
    await deleteAccount({ userId: TARGET, removeImages: false, removeModels: true });

    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      userId: TARGET,
      removeImages: false,
      removeModels: true,
    });
  });

  it("surfaces the endpoint's own refusal text to the operator", async () => {
    respond = () =>
      new Response(
        JSON.stringify({ message: `User ${TARGET} is already deleted; nothing to delete.` }),
        { status: 400 }
      );

    const result = await deleteAccount({ userId: TARGET });

    // An answered refusal must arrive intact. A bare "returned 400", or folding it into "may have
    // completed", destroys the only sentence telling the operator the account is already gone
    // rather than the route broken.
    expect(result).toEqual({
      ok: false,
      error: `Account deletion: User ${TARGET} is already deleted; nothing to delete.`,
    });
  });
});

describe('deleteAccount — the audit row belongs to the endpoint', () => {
  // 🔴 If you are here because you added `logAction` for consistency with `purgeAllContent`, read
  // the file header. The endpoint already wrote this row against the same moderator.
  it('writes NO ModActivity row of its own', async () => {
    await deleteAccount({ userId: TARGET });

    expect(recordModActivity).not.toHaveBeenCalled();
    // The batch form too. `logAction` uses the single-row function, but the plausible shape of the
    // "add it back for symmetry" edit is whichever one the author reaches for, and a guard blind to
    // half of them is a guard that fails on the edit it exists to catch.
    expect(recordModActivityBatch).not.toHaveBeenCalled();
  });

  // The control. `recordModActivity` is mocked and observable, so the assertion above is capable of
  // failing — a neighbouring action that DOES log proves the spy is wired to the real call site.
  it('while its neighbour purgeAllContent still does', async () => {
    await purgeAllContent({ userId: TARGET, moderatorId: 990000007 });

    expect(recordModActivity).toHaveBeenCalledWith({
      userId: 990000007,
      entityType: 'user',
      entityId: TARGET,
      activity: 'purgeAllContent',
    });
  });
});

/**
 * 🔴 WHAT MAY BE CALLED A FAILURE, AND WHAT MAY NOT.
 *
 * `deleteUser` commits before an unbounded post-commit step. So for THIS action a lost response is
 * not evidence that nothing happened — and `fetch` rejects with the identical
 * `TypeError: fetch failed` whether nothing was listening or the socket died mid-request after the
 * server had already acted. Only `cause.code` separates them.
 *
 * The rule these cases pin: when no answer came back, or a 5xx or 408 did, only a code proving the
 * request never left may be reported as a failure; a refusal below 500 passes through as one.
 * Everything else sends the operator to look, because the alternative is telling somebody
 * a committed deletion failed when it did not, and having them do it again.
 */
describe('deleteAccount — a lost response is not a failed deletion', () => {
  const rejectWith = (e: Error) =>
    vi.stubGlobal('fetch', () => {
      calls.push({ url: 'stubbed', init: {} });
      return Promise.reject(e);
    });

  it('our own abort says the deletion may have completed', async () => {
    const e = new Error('The operation was aborted due to timeout');
    e.name = 'TimeoutError';
    rejectWith(e);

    expect(await deleteAccount({ userId: TARGET })).toEqual({
      ok: false,
      error: MAY_HAVE_COMPLETED,
    });
  });

  // A socket reaped mid-request presents as the same bare `TypeError: fetch failed` as nothing
  // listening; only `cause.code` separates them.
  it('a socket that dies MID-REQUEST says the same, not "failed"', async () => {
    const e = new TypeError('fetch failed');
    (e as Error & { cause?: unknown }).cause = { code: 'UND_ERR_SOCKET' };
    rejectWith(e);

    expect(await deleteAccount({ userId: TARGET })).toEqual({
      ok: false,
      error: MAY_HAVE_COMPLETED,
    });
  });

  // THE CONTROL for the catch branch: nothing was listening, so the request provably never left.
  // A catch that ignored `cause.code` would pass both cases above.
  it('a refused connection IS a failure, because the request never left', async () => {
    const e = new TypeError('fetch failed');
    (e as Error & { cause?: unknown }).cause = { code: 'ECONNREFUSED' };
    rejectWith(e);

    expect(await deleteAccount({ userId: TARGET })).toEqual({
      ok: false,
      error: 'Account deletion failed.',
    });
  });

  it("an intermediary's gateway timeout is a lost response, not a refusal", async () => {
    // HTML, not JSON: `restErrorReason` finds nothing, so without the status check this arrived as
    // a bare "Account deletion returned 504." over a deletion that was very likely still running.
    respond = () => new Response('<html>Gateway Timeout</html>', { status: 504 });

    expect(await deleteAccount({ userId: TARGET })).toEqual({
      ok: false,
      error: MAY_HAVE_COMPLETED,
    });
  });

  // 🔴 EVERY 408 IS A LOST RESPONSE, EVEN ONE IN THE APP'S OWN ENVELOPE. This endpoint authors no
  // 408 — a raw Prisma timeout leaves `handleEndpointError` as a 500, and only `throwDbError`-style
  // wrappers map P1008/P2024 to 408, which nothing on this path calls — so an enveloped 408 is an
  // intermediary's.
  it('treats an ENVELOPED 408 as a lost response, not a refusal', async () => {
    respond = () =>
      new Response(JSON.stringify({ message: 'The request timed out' }), { status: 408 });

    expect(await deleteAccount({ userId: TARGET })).toEqual({
      ok: false,
      error: MAY_HAVE_COMPLETED,
    });
  });

  it('treats a 408 with no app envelope as a lost response', async () => {
    respond = () => new Response('<html>Request Timeout</html>', { status: 408 });

    expect(await deleteAccount({ userId: TARGET })).toEqual({
      ok: false,
      error: MAY_HAVE_COMPLETED,
    });
  });

  // 🔴 A JSON 5xx satisfies the envelope reader, so `reason` is recovered — and it must still read
  // as a lost response, whoever wrote it. The recovered text is logged, not discarded.
  it('treats a JSON 504 as a lost response even though the envelope reader accepts it', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    respond = () =>
      new Response(JSON.stringify({ message: 'Endpoint request timed out' }), { status: 504 });

    // ONE instruction in the operator's message. Appending the recovered text would add, for an
    // app-authored 5xx, the genericized "An unexpected error occurred", and for a 503 a
    // hand-written "retry" contradicting the sentence it was glued to.
    expect(await deleteAccount({ userId: TARGET })).toEqual({
      ok: false,
      error: MAY_HAVE_COMPLETED,
    });

    // But not discarded — the detail an operator does not need is the detail an engineer does.
    expect(logged).toHaveBeenCalledWith(
      '[user-actions] account deletion lost its response',
      expect.objectContaining({ status: 504, reason: 'Endpoint request timed out' })
    );
    logged.mockRestore();
  });

  // The boundary itself. Without a non-504 case, mutating `>= 500` to `>= 504` leaves every other
  // test in this file green — and 500 is what an actual crash produces.
  it('treats a 500 as a lost response too, not just the gateway statuses', async () => {
    respond = () => new Response('<html>Internal Server Error</html>', { status: 500 });

    expect(await deleteAccount({ userId: TARGET })).toEqual({
      ok: false,
      error: MAY_HAVE_COMPLETED,
    });
  });

  // 🔴 A 429 IS ROUTINE HERE, NOT EXCEPTIONAL. The endpoint allows 5 per minute and an erasure
  // backlog is worked in batches, so a moderator meets this regularly — and the retry window is the
  // only sentence telling them how long to wait. A plausible future simplification ("anything
  // without `deleted: true` is unconfirmed") would swallow it.
  it('passes a rate-limit refusal through with its retry window intact', async () => {
    respond = () =>
      new Response(JSON.stringify({ error: 'Rate limit exceeded', retryAfterSeconds: 37 }), {
        status: 429,
      });

    const result = await deleteAccount({ userId: TARGET });

    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain('37');
  });

  // The app's own 401 reaches the operator with the endpoint's text.
  it("passes the endpoint's own 401 through rather than guessing at advice", async () => {
    respond = () => new Response(JSON.stringify({ error: 'Not signed in' }), { status: 401 });

    expect(await deleteAccount({ userId: TARGET })).toEqual({
      ok: false,
      error: 'Account deletion: Not signed in',
    });
  });

  // A 401 without the app's envelope came from something in front of it, so "sign in to civitai.com
  // again" would be a guess. Re-adding that advice for session calls reddens this case.
  it('adds no sign-in advice to a 401 the app did not write', async () => {
    respond = () => new Response('<html>Unauthorized</html>', { status: 401 });

    expect(await deleteAccount({ userId: TARGET })).toEqual({
      ok: false,
      error: 'Account deletion returned 401.',
    });
  });

  // A front door refusing to pass the request on: no envelope, below 500, not 408. Nothing reached
  // the handler, so this is honestly a failure.
  it('treats a non-app 403 as a plain failure, because nothing ran', async () => {
    respond = () => new Response('<html>Forbidden</html>', { status: 403 });

    expect(await deleteAccount({ userId: TARGET })).toEqual({
      ok: false,
      error: 'Account deletion returned 403.',
    });
  });

  // HAZARD PIN, not a behaviour test. Nothing else notices an edit that drops the fourth argument
  // to `callModEndpoint` and silently returns this call to the 30s default.
  it('asks for a 60s budget, not the 30s default', async () => {
    const budgets: number[] = [];
    const real = AbortSignal;
    vi.stubGlobal('AbortSignal', {
      timeout: (ms: number) => {
        budgets.push(ms);
        return real.timeout(ms);
      },
    });

    await deleteAccount({ userId: TARGET });

    expect(budgets).toEqual([60_000]);
  });
});

describe('deleteAccount — what it does with the response', () => {
  it('refuses to report success for a 2xx that is not the success envelope', async () => {
    respond = () => new Response('<html>signed out</html>', { status: 200 });

    const result = await deleteAccount({ userId: TARGET });

    // For an erasure the false positive is the expensive direction: the request gets closed and the
    // data is still there. No live path to a non-JSON 200 is known — this is here on that asymmetry.
    expect(result).toEqual({ ok: false, error: MAY_HAVE_COMPLETED });
  });

  // The real envelope must still pass beside the case above, or its check is just a function that
  // always refuses.
  it('accepts the real success envelope', async () => {
    const result = await deleteAccount({ userId: TARGET });
    expect(result).toEqual({ ok: true });
  });
});

describe('deleteAccount — the mistyped-id confirmation', () => {
  it('sends the username when it has one', async () => {
    await deleteAccount({ userId: TARGET, username: 'not_a_real_user' });

    // The ONLY check that catches a mistyped id which happens to be another LIVE account. The
    // endpoint's unknown-id and already-deleted refusals cannot see that case at all.
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      userId: TARGET,
      username: 'not_a_real_user',
    });
  });
});
