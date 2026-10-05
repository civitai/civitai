import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

/**
 * `/api/mod/user/delete` — the moderator path to a data-subject erasure request.
 *
 * Where a refusal could pass for the wrong reason, it is paired with a control: the same call where
 * it must succeed. Without that arm it passes for any reason at all, including no route. The
 * endpoint calls `deleteUser` rather than doing the work itself, so inlining the scrub later
 * reddens here.
 *
 * Lives outside `src/pages/**` because Next enumerates every file under it as a route — see
 * `src/__tests__/pages/no-test-files-in-pages-tree.test.ts`.
 *
 * The actor on the audit row has its own file: `delete-audit-attribution.test.ts`.
 */

const { mockAudit, mockUserActivity, session, bearerSession } = vi.hoisted(() => ({
  bearerSession: { value: null as unknown },
  mockAudit: vi.fn(),
  mockUserActivity: vi.fn(),
  session: {
    user: { id: 990000007, isModerator: true, permissions: [], bannedAt: null } as Record<
      string,
      unknown
    >,
  },
}));

vi.mock('~/server/auth/bearer-token', () => ({
  getSessionFromBearerToken: vi.fn(async () => bearerSession.value),
}));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => session),
}));
vi.mock('~/server/clickhouse/client', () => ({
  Tracker: class {
    retoolAudit = mockAudit;
    userActivity = mockUserActivity;
  },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  handleEndpointError: (
    res: { status: (n: number) => { json: (b: unknown) => unknown } },
    e: unknown
  ) => {
    // The REAL mapper, not a hand-written table. A table here has to be extended every time the
    // handler learns a new refusal code, and the failure when it is not is a 500 in a test asserting
    // a 4xx — which reads as a bug in the endpoint.
    const status = e instanceof TRPCError ? getHTTPStatusCodeFromError(e) : 500;
    return res
      .status(status)
      .json({ error: (e as { code?: string }).code ?? 'error', message: (e as Error).message });
  },
}));

const deleteUser = vi.fn(async () => ({}));
vi.mock('~/server/services/user.service', () => ({
  deleteUser: (...a: unknown[]) => deleteUser(...(a as [])),
}));
const trackModActivity = vi.fn(async () => undefined);
vi.mock('~/server/services/moderator.service', () => ({
  trackModActivity: (...a: unknown[]) => trackModActivity(...(a as [])),
}));
const hasModeratorGrant = vi.fn<(...a: unknown[]) => Promise<boolean>>(async () => true);
vi.mock('~/server/services/moderator-grants', () => ({
  hasModeratorGrant: (...a: unknown[]) => hasModeratorGrant(...a),
}));

import handler from '~/pages/api/mod/user/delete';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const TARGET = 8675309;
/** The confirmation the endpoint REQUIRES for any account that has a username. */
const NAME = 'not_a_real_user';

function call(
  body: Record<string, unknown>,
  context?: { tokenScope?: number },
  headers: Record<string, string> = {},
  query: Record<string, unknown> = {}
) {
  const req = {
    method: 'POST',
    headers,
    body,
    query,
    ...(context ? { context } : {}),
  } as Parameters<typeof handler>[0];
  let statusCode = 200;
  let payload: unknown;
  const res = {
    status(c: number) {
      statusCode = c;
      return res;
    },
    json(b: unknown) {
      payload = b;
      return res;
    },
    setHeader: vi.fn(),
    end() {
      return res;
    },
  } as unknown as Parameters<typeof handler>[1];
  return handler(req, res).then(() => ({ status: statusCode, body: payload }));
}

/** A live account: exists, not deleted. */
function liveTarget(username: string | null = 'not_a_real_user') {
  dbMock.dbWrite.user.findFirst.mockResolvedValue({
    id: TARGET,
    username,
    deletedAt: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  session.user = { id: 990000007, isModerator: true, permissions: [], bannedAt: null };
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  redisMock.sysRedis.ttl.mockResolvedValue(60);
  bearerSession.value = null;
  liveTarget();
});

describe('user.delete — who is allowed to call it', () => {
  it('refuses a signed-in NON-moderator', async () => {
    session.user = { id: 990000099, isModerator: false, permissions: [], bannedAt: null };
    const { status, body } = await call({ userId: TARGET, username: NAME });
    expect(status).toBe(403);
    expect(body).toEqual({ error: 'Moderator role required' });
    expect(deleteUser).not.toHaveBeenCalled();
  });

  // THE CONTROL for the case above. Same call, moderator session: it must reach `deleteUser`.
  // Without this arm, the 403 assertion would also pass against an endpoint that refuses everyone.
  it('allows a moderator to make the SAME call', async () => {
    const { status } = await call({ userId: TARGET, username: NAME });
    expect(status).toBe(200);
    expect(deleteUser).toHaveBeenCalledTimes(1);
  });

  it('refuses a moderator without the user.deleteAccount permission', async () => {
    hasModeratorGrant.mockResolvedValueOnce(false);
    const { status } = await call({ userId: TARGET, username: NAME });
    expect(status).toBe(403);
    expect(hasModeratorGrant).toHaveBeenCalledWith(
      expect.objectContaining({ id: 990000007 }),
      'user.deleteAccount'
    );
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('refuses a banned moderator', async () => {
    session.user = {
      id: 990000007,
      isModerator: true,
      permissions: [],
      bannedAt: new Date('2026-01-01'),
    };
    const { status } = await call({ userId: TARGET, username: NAME });
    expect(status).toBe(403);
    expect(deleteUser).not.toHaveBeenCalled();
  });
});

describe('user.delete — it delegates, it does not reimplement', () => {
  it('calls `deleteUser` with the parsed options', async () => {
    const { status, body } = await call({
      userId: String(TARGET),
      username: NAME,
      removeModels: 'true',
      removeImages: 'false',
    });
    expect(status).toBe(200);
    // The id is a NUMBER here although it arrived as a string, and the two booleans are booleans:
    // that is the parse. `'false'` must reach `deleteUser` as `false` — as a string,
    // `imageRemovalMode` reads it as immediate.
    expect(deleteUser).toHaveBeenCalledWith({
      id: TARGET,
      username: NAME,
      removeModels: true,
      removeImages: false,
    });
    expect(body).toEqual({ deleted: true, userId: TARGET, auditRecorded: true });
  });

  // Stored and typed values are identical here; the trim case below is what pins that the STORED
  // one is sent.
  it('passes the username to the service', async () => {
    await call({ userId: TARGET, username: 'not_a_real_user' });
    expect(deleteUser).toHaveBeenCalledWith({
      id: TARGET,
      username: 'not_a_real_user',
      removeModels: undefined,
      // Defaulted, not absent — see the grace-period case below.
      removeImages: false,
    });
  });

  it('refuses when the supplied username belongs to somebody else', async () => {
    const { status, body } = await call({ userId: TARGET, username: 'no_such_account_x7' });
    expect(status).toBe(400);
    expect(body).toMatchObject({
      message: `That username does not belong to user ${TARGET}. Check the id and try again.`,
    });
    expect(deleteUser).not.toHaveBeenCalled();
  });

  // `usernameSchema` allows [A-Za-z0-9_] only, and about 630 live rows (2026-09-22) are outside
  // it. Validating the moderator's confirmation against it would 400 on exactly the odd accounts
  // this endpoint is for.
  it('accepts a username outside the username CHARSET when the row carries it', async () => {
    liveTarget('not.a.real.user');
    const { status } = await call({ userId: TARGET, username: 'not.a.real.user' });
    expect(status).toBe(200);
    expect(deleteUser).toHaveBeenCalledTimes(1);
  });

  // The schema trims the confirmation, and some stored usernames end in a character `trim` strips
  // (U+00A0 among them). Compared exactly, such an account could never be confirmed, and since
  // confirmation is mandatory it could never be deleted here at all.
  it('confirms a stored username that ends in a character `trim` strips', async () => {
    liveTarget('not_a_real_user ');
    const { status } = await call({ userId: TARGET, username: 'not_a_real_user' });
    expect(status).toBe(200);
    // The STORED value goes to `deleteUser`, which matches on it exactly.
    expect(deleteUser).toHaveBeenCalledWith(
      expect.objectContaining({ id: TARGET, username: 'not_a_real_user ' })
    );
  });
});

/**
 * 🔴 THE CONFIRMATION IS REQUIRED, NOT OFFERED — and this is the case nothing else catches.
 *
 * An unknown id is refused by the 404. An already-deleted one is refused by its own guard. A
 * mistyped id that happens to land on another LIVE account is refused by neither, and the deletion
 * is not undoable in the part that matters. So omission cannot be a caller's quiet choice.
 *
 * It keys on the row HAVING a username rather than on "not deleted", because 8,069 live accounts
 * carry a NULL username (prod, 2026-09-21) and demanding confirmation from them would make every
 * one undeletable through this route.
 */
describe('user.delete — confirming which account', () => {
  it('refuses a live account when no username was sent', async () => {
    const { status, body } = await call({ userId: TARGET });
    expect(status).toBe(400);
    expect(body).toMatchObject({
      message:
        'Send `username` to confirm which account is being deleted — look it up before retrying.',
    });
    // 🔴 THE REFUSAL MUST NOT NAME THE ACCOUNT. A confirmation that hands back the value it asks you
    // to know is not a confirmation: the operator this guard exists for typed a NUMBER, so they have
    // no independent expectation of the name — told it, they paste it back and erase the wrong live
    // account, with both calls audited as deliberate.
    expect(JSON.stringify(body)).not.toContain(NAME);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  // THE CONTROL. The same call WITH the confirmation must go through, or the refusal above would
  // also hold for an endpoint that refuses everything.
  it('accepts the same call once the username confirms it', async () => {
    const { status } = await call({ userId: TARGET, username: NAME });
    expect(status).toBe(200);
    expect(deleteUser).toHaveBeenCalledTimes(1);
  });

  // The 8,069. A live row with no username has nothing to confirm against, so demanding it would
  // lock the account out of this route permanently.
  it('does NOT demand confirmation from a live account that has no username', async () => {
    liveTarget(null);
    const { status } = await call({ userId: TARGET });
    expect(status).toBe(200);
    expect(deleteUser).toHaveBeenCalledTimes(1);
  });
});

describe('user.delete — the already-deleted refusal', () => {
  it('refuses an account that is already deleted, and says so', async () => {
    dbMock.dbWrite.user.findFirst.mockResolvedValue({
      id: TARGET,
      username: null,
      deletedAt: new Date('2026-07-30'),
    });
    const { status, body } = await call({ userId: TARGET, username: NAME });
    expect(status).toBe(400);
    // Named message, not a bare status: `deleteUser` has NO deletedAt filter of its own, so a
    // second run would re-scrub the row and re-cancel the subscriptions. The operator has to be
    // able to tell this apart from a failure.
    expect(body).toMatchObject({
      message: `User ${TARGET} is already deleted; nothing to delete.`,
    });
    expect(deleteUser).not.toHaveBeenCalled();
  });

  // THE CONTROL: the identical call against a live row must go through, or the refusal above
  // would also pass against an endpoint that refuses every account.
  it('deletes an account that is NOT yet deleted', async () => {
    const { status } = await call({ userId: TARGET, username: NAME });
    expect(status).toBe(200);
    expect(deleteUser).toHaveBeenCalledTimes(1);
  });

  it('404s an id that does not exist at all', async () => {
    dbMock.dbWrite.user.findFirst.mockResolvedValue(null);
    const { status, body } = await call({ userId: TARGET, username: NAME });
    expect(status).toBe(404);
    expect(body).toMatchObject({ message: `No user with id ${TARGET}` });
    expect(deleteUser).not.toHaveBeenCalled();
  });
});

/**
 * 🔴 THE CONFIRMATION IS ACCEPTED FROM THE BODY ONLY, AND THE REFUSAL SAYS WHERE TO PUT IT.
 *
 * `collectInput` lets the query string win over the body, so `?username=` would otherwise work.
 * Refused rather than documented: a rule a caller can break by accident is not a rule, and the
 * caller this fires on is a script author who needs to be told what to do instead.
 */
describe('user.delete — where the confirmation may travel', () => {
  it('refuses a username sent in the query string, and says where to put it', async () => {
    const { status, body } = await call({ userId: TARGET }, undefined, {}, { username: NAME });

    expect(status).toBe(400);
    expect(body).toMatchObject({
      message: 'Send `username` in the request body, not the query string.',
    });
    expect(deleteUser).not.toHaveBeenCalled();
  });

  // THE CONTROL. The same confirmation in the body must still work, or the refusal above would
  // hold for an endpoint that rejects the parameter outright.
  it('accepts the same confirmation in the body', async () => {
    const { status } = await call({ userId: TARGET, username: NAME });
    expect(status).toBe(200);
    expect(deleteUser).toHaveBeenCalledTimes(1);
  });
});

/**
 * 🔴 A REFUSAL IS ALSO A RECORD. The framework writes a throw's message into the audit row's
 * `errorMsg`, which `auditExclude` structurally cannot reach — so a refusal that quotes the name
 * puts it back in the row the exclusion just cleaned, by a different column.
 */
describe('user.delete — refusals name no account', () => {
  // The refusal itself is asserted by the mismatch test above. This one carries only the property
  // that test cannot: neither the string the operator typed nor the row's own username appears
  // anywhere in the response — and therefore in the `errorMsg` the framework records from it.
  it('names no account when the confirmation does not match', async () => {
    const { body } = await call({ userId: TARGET, username: 'no_such_account_x7' });

    expect(JSON.stringify(body)).not.toContain('no_such_account_x7');
    expect(JSON.stringify(body)).not.toContain(NAME);
  });

  // THE CONTROL for both `not.toContain`s: the id, which the message DOES carry, is found by the
  // same search. Without it, a response the assertions could not see would pass.
  it('does carry the id, so the assertions above can see the message at all', async () => {
    const { body } = await call({ userId: TARGET, username: 'no_such_account_x7' });

    expect(JSON.stringify(body)).toContain(String(TARGET));
  });
});

/**
 * 🔴 THE ERASURE MUST NOT LEAVE THE IDENTIFIER IN THE AUDIT STORE.
 *
 * `deleteUser` nulls the username in Postgres and the `ModActivity` row carries ids only, so the
 * ClickHouse audit payload would otherwise be the ONE place the erased person's identifier survives
 * their erasure — kept because the confirmation happened to be a request parameter, not because
 * anyone decided to keep it.
 *
 * The confirmation still runs. Only the recorded copy is dropped, and the user id — the key an
 * investigation actually needs — is still there.
 */
describe('user.delete — what the audit row keeps', () => {
  it('records the id it acted on but NOT the username it was confirmed with', async () => {
    const { status } = await call({ userId: TARGET, username: NAME });

    expect(status).toBe(200);
    expect(mockAudit).toHaveBeenCalledTimes(1);
    const payload = mockAudit.mock.calls[0][0].payload as Record<string, unknown>;
    expect(payload).toEqual({ userId: TARGET });
    // Belt and braces: the whole row, not just the key we thought to name.
    expect(JSON.stringify(mockAudit.mock.calls[0][0])).not.toContain(NAME);
  });

  it('still records the action and the account it was called against', async () => {
    await call({ userId: TARGET, username: NAME });

    expect(mockAudit.mock.calls[0][0]).toMatchObject({
      action: 'user.delete',
      outcome: 'ok',
      affected: { userIds: [TARGET] },
    });
  });
});

describe('user.delete — token scope', () => {
  // The self-serve `user.delete` procedure is `requiredScope: TokenScope.Full`, so a scoped token
  // cannot delete even its own account. This route must not be the looser way in.
  const NARROW = TokenScope.MediaRead;

  it('refuses a token that is not full-scope', async () => {
    const { status } = await call({ userId: TARGET, username: NAME }, { tokenScope: NARROW });
    expect(status).toBe(403);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  // THE CONTROL. Same call, full scope: without it the refusal above passes against an endpoint
  // that refuses every token, or one whose scope check rejects unconditionally.
  it('allows the SAME call with a full-scope token', async () => {
    const { status } = await call(
      { userId: TARGET, username: NAME },
      { tokenScope: TokenScope.Full }
    );
    expect(status).toBe(200);
    expect(deleteUser).toHaveBeenCalledTimes(1);
  });

  // A cookie session carries no scope at all, and is the full-authority case. If this reddened,
  // every moderator using the moderator app would be locked out of the route.
  it('treats a cookie session (no scope on the request) as full', async () => {
    const { status } = await call({ userId: TARGET, username: NAME });
    expect(status).toBe(200);
  });

  // 🔴 THE BEARER BRANCH IS A SEPARATE RESOLUTION. `resolveActor` reads the scope from a different
  // place here than on the cookie path, and a scope lost on this branch must not read as full —
  // with the three cases above still green, because none of them takes this branch.
  it('refuses a NARROW bearer token', async () => {
    bearerSession.value = {
      user: { id: 990000007, isModerator: true, permissions: [], bannedAt: null },
      tokenScope: TokenScope.MediaRead,
    };
    const { status } = await call({ userId: TARGET, username: NAME }, undefined, {
      authorization: 'Bearer key',
    });
    expect(status).toBe(403);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('allows the SAME bearer call at full scope', async () => {
    bearerSession.value = {
      user: { id: 990000007, isModerator: true, permissions: [], bannedAt: null },
      tokenScope: TokenScope.Full,
    };
    const { status } = await call({ userId: TARGET, username: NAME }, undefined, {
      authorization: 'Bearer key',
    });
    expect(status).toBe(200);
    expect(deleteUser).toHaveBeenCalledTimes(1);
  });
});

describe('user.delete — images are kept unless removal is asked for', () => {
  it('defaults `removeImages` to false, which is the grace period', async () => {
    await call({ userId: TARGET, username: NAME });
    // `imageRemovalMode` reads `removeImages === false ? 'grace' : 'immediate'`, so `false` is the
    // ONLY value that spares them; an absent value would mean immediate and irrecoverable.
    expect(deleteUser).toHaveBeenCalledWith(
      expect.objectContaining({ id: TARGET, removeImages: false })
    );
  });

  it('still destroys them immediately when a moderator asks', async () => {
    await call({ userId: TARGET, username: NAME, removeImages: 'true' });
    expect(deleteUser).toHaveBeenCalledWith(
      expect.objectContaining({ id: TARGET, removeImages: true })
    );
  });
});

/**
 * 🔴 NAMED FOR AN ORDERING, NOT FOR A FUNCTION. The handler resolves `deletedAt` BEFORE it compares
 * `username`, and that sequence is the whole of this test.
 *
 * Why it matters: a deletion can complete and still be reported to the operator as a failure (the
 * request aborts while an unbounded post-commit step runs). The operator retries. On that retry the
 * row is already scrubbed, so its `username` is NULL — and a username comparison placed first would
 * answer "that username does not belong to user N", i.e. "wrong id", about the account they had just
 * correctly deleted. The true state has to win over the mismatch.
 *
 * A tidy-up that moves the username compare above the `deletedAt` guard silently produces that.
 */
describe('user.delete — the retry path, after a deletion reported as failed', () => {
  it('answers ALREADY DELETED, not a username mismatch, when the username is now null', async () => {
    const { status: first } = await call({ userId: TARGET, username: 'not_a_real_user' });
    expect(first).toBe(200);

    // What the row looks like after `deleteUser`: scrubbed, username null.
    dbMock.dbWrite.user.findFirst.mockResolvedValue({
      id: TARGET,
      username: null,
      deletedAt: new Date('2026-07-30'),
    });

    const { status, body } = await call({ userId: TARGET, username: 'not_a_real_user' });
    expect(status).toBe(400);
    expect(body).toMatchObject({
      message: `User ${TARGET} is already deleted; nothing to delete.`,
    });
    expect(deleteUser).toHaveBeenCalledTimes(1);
  });
});
