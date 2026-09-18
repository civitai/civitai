import { beforeEach, describe, expect, it, vi } from 'vitest';
// Setup-order import: installs the `~/env/server` mock carrying the real test RSA keypair
// BEFORE `block-token.service` reads env at module load. Same posture as the sibling
// real-JWT suites (`block-scope.approved-gate.test.ts`).
import '~/__tests__/setup';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * BANNING A PUBLISHER MUST REACH THE BLOCK TOKENS THEIR BLOCKS ALREADY HOLD.
 *
 * 🔴 STATE THE RESIDUAL NARROWLY — a ban was never a no-op. It already unpublishes the
 * user's models, cancels the subscription, blocks their media and invalidates their
 * sessions. What it did NOT do is write any of the three markers the runtime guards read,
 * so a block token minted before the ban kept authenticating against the REST wrapper
 * (`withBlockScope`) and the tRPC bridge (`authorizeBlockBridgeToken`) until its natural
 * `exp` — 900s by default, 14400s for a `dev` token. That window, and only that window, is
 * what `revokeBlockInstancesForPublisher` closes (clawgate #618).
 *
 * WHAT IS REAL HERE AND WHAT IS NOT. The tokens are real RS256 JWTs from the real signer.
 * `BlockRevocation`, the REST middleware's revocation branch and the tRPC bridge guard all
 * run for real. Redis is the canonical mock wired to an in-memory Map, so the marker
 * `toggleBan` WRITES is the marker the guard READS — the seam this card is about. Only the
 * DB rows and the runtime feature flag are stubbed.
 *
 * 🔴 THE FIXTURE IS BUILT TO DEFEAT TWO DIFFERENT WRONG IMPLEMENTATIONS, and both of them
 * are wrong implementations this change actually had.
 *
 *   (a) FOUR PINNED INSTANCES ACROSS TWO BLOCKS — a single-instance fixture passes with a
 *       loop that revokes only its first row.
 *   (b) FOUR SYNTHESISED IDS ACROSS THE OTHER FOUR NAMESPACES — `bus_pub_*`, `bus_view_*`,
 *       `pdb_*`, `page_*`. A fixture built only from rows whose `blockInstanceId` column is
 *       populated agrees with the first version of the writer, which selected
 *       `blockInstanceId: { not: null }` and reached one namespace out of five while every
 *       comment in the change said "every live instance". `publisher_all_my_models` blanket
 *       — the shape it missed — is the publisher's own default install.
 *
 * The namespace set itself is pinned separately, against the canonical parser, in
 * `blocks/__tests__/publisher-ban-revocation.namespaces.test.ts`: this file can only ever
 * check the ids someone thought to write down, and that is the half that decayed.
 */

const { isFliptMock, mockRemoveContent, mockSendModerationEmail } = vi.hoisted(() => ({
  isFliptMock: vi.fn(async (flag: string) => flag === 'app-blocks-runtime-enabled'),
  mockRemoveContent: vi.fn(async () => undefined),
  mockSendModerationEmail: vi.fn(async (..._a: unknown[]) => undefined),
}));

vi.mock('~/server/flipt/client', () => ({ isFlipt: isFliptMock }));
vi.mock('~/server/email/templates', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, moderationActionEmail: { send: mockSendModerationEmail } };
});
vi.mock('~/server/meilisearch/util', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, removeUserContentFromSearchIndex: mockRemoveContent };
});

import { dbMock } from '~/__tests__/mocks/db.mock';
import { REDIS_KEYS } from '~/server/redis/client';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { withBlockScope } from '~/server/middleware/block-scope.middleware';
import { BlockTokenService } from '~/server/services/block-token.service';
import { authorizeBlockBridgeToken } from '~/server/services/blocks/block-bridge-auth.service';
import { BlockRevocation } from '~/server/services/block-revocation.service';
import { revokeBlockInstancesForPublisher } from '~/server/services/blocks/publisher-ban-revocation.service';

const { toggleBan } = await import('~/server/services/user.service');
const { BanReasonCode } = await import('~/server/common/enums');

const PUBLISHER_ID = 90618;
const ACTOR_ID = 90619;
const ALREADY_BANNED_AT = new Date('2026-02-03T04:05:06.000Z');
const SCOPE = 'user:read:self';

/**
 * Two app blocks, two PINNED instances each. `appBlockId` differs across the pair so a
 * loop that breaks after the first BLOCK is as visible as one that breaks after the
 * first ROW.
 */
const PINNED = [
  { appBlockId: 'apb_618_one', blockId: 'blk_618_one', blockInstanceId: 'bki_618_one_a' },
  { appBlockId: 'apb_618_one', blockId: 'blk_618_one', blockInstanceId: 'bki_618_one_b' },
  { appBlockId: 'apb_618_two', blockId: 'blk_618_two', blockInstanceId: 'bki_618_two_a' },
  { appBlockId: 'apb_618_two', blockId: 'blk_618_two', blockInstanceId: 'bki_618_two_b' },
];

/**
 * 🔴 THE BLANKET ROWS, WHICH THE FIRST VERSION OF THIS WRITER SILENTLY SKIPPED.
 *
 * `BlockUserSubscription.blockInstanceId` is NULL for a blanket subscription; the id its
 * tokens carry is SYNTHESISED on read — `'bus_pub_' || bus.id` and `'bus_view_' || bus.id`
 * in `BlockRegistry.listForModel`. The guards compare `claims.blockInstanceId` verbatim,
 * so a marker under the synthesised id works — but a `where` of
 * `blockInstanceId: { not: null }` never selects the row, and `publisher_all_my_models`
 * blanket is the publisher's OWN default install shape. A fixture built only from pinned
 * rows agrees with the bug.
 */
const BLANKET = [
  {
    id: 'bus_618_blanket',
    scope: 'publisher_all_my_models',
    instanceId: 'bus_pub_bus_618_blanket',
  },
  { id: 'bus_618_viewer', scope: 'viewer_personal', instanceId: 'bus_view_bus_618_viewer' },
];

/**
 * The two surfaces that hang off the APP BLOCK and have no subscription row at all, so no
 * query over `BlockUserSubscription` can reach them: the platform-default promotion and
 * the `<slug>.civit.ai` full page.
 */
const OWNED_APP_BLOCK_IDS = ['apb_618_one', 'apb_618_two'];
const APP_BLOCK_SURFACE_IDS = OWNED_APP_BLOCK_IDS.flatMap((id) => [`pdb_${id}`, `page_${id}`]);

/** Every instance id a ban on this publisher must reach, across all five namespaces. */
const ALL_INSTANCE_IDS = [
  ...PINNED.map((p) => p.blockInstanceId),
  ...BLANKET.map((b) => b.instanceId),
  ...APP_BLOCK_SURFACE_IDS,
];

const APP_ID = 'app_618';

/** The in-memory Redis the marker is written into and read back out of. */
const store = new Map<string, string>();

const userFindUnique = dbMock.dbRead.user.findUnique;
const userUpdate = dbMock.dbWrite.user.update;
const userFindFirst = dbMock.dbWrite.user.findFirst;
const subscriptionFindMany = dbMock.dbWrite.blockUserSubscription.findMany;
const appBlockFindMany = dbMock.dbWrite.appBlock.findMany;
const appBlockFindUnique = dbMock.dbRead.appBlock.findUnique;
// The ban fan-out chains `.catch` on each of these; an undeclared write verb returns
// `undefined` from the canonical mock and the fan-out then throws on `.catch`.
const userLinkDeleteMany = dbMock.dbWrite.userLink.deleteMany;
const imageUpdateMany = dbMock.dbWrite.image.updateMany;
const commentUpdateMany = dbMock.dbWrite.comment.updateMany;
const commentV2UpdateMany = dbMock.dbWrite.commentV2.updateMany;

async function mint(
  blockInstanceId: string,
  blockId: string,
  appBlockId = OWNED_APP_BLOCK_IDS[0]
): Promise<string> {
  const { token } = await BlockTokenService.sign({
    userId: 7,
    blockId,
    appId: APP_ID,
    appBlockId,
    blockInstanceId,
    scopes: [SCOPE],
    ctx: {},
  } as Parameters<typeof BlockTokenService.sign>[0]);
  return token;
}

function makeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    send() {
      return this;
    },
    end() {
      return this;
    },
    setHeader() {
      return this;
    },
    removeHeader() {
      return undefined;
    },
    writeHead() {
      return this;
    },
    getHeader() {
      return undefined;
    },
    on() {
      return this;
    },
  };
  return res as unknown as NextApiResponse & { statusCode: number; body: unknown };
}

function makeReq(token: string): NextApiRequest {
  return {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
    query: {},
    url: '/api/v1/blocks/me',
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as NextApiRequest;
}

/** One REST bridge request on the real middleware. */
async function driveRest(token: string) {
  const handler = vi.fn(async (_req: NextApiRequest, res: NextApiResponse) => {
    res.status(200).json({ via: 'handler' });
  });
  const route = withBlockScope(handler as never, { endpoint: 'me', requiredScope: SCOPE });
  const res = makeRes();
  await route(makeReq(token) as never, res as never);
  return { handler, res };
}

const banPublisher = () =>
  toggleBan({
    id: PUBLISHER_ID,
    reasonCode: BanReasonCode.Other,
    userId: ACTOR_ID,
    isModerator: true,
  } as Parameters<typeof toggleBan>[0]);

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();

  // `clearAllMocks` does not reach the hybrid-proxy nodes the canonical mocks are built
  // from, so implementations have to be (re)declared rather than assumed cleared.
  //
  // 🔴 EVERY FAKE YIELDS TO THE MACROTASK QUEUE, AND THAT IS THE WHOLE ORDERING GUARD.
  // AC-1 is a HAPPENS-BEFORE claim — "the ban has completed, therefore the next request is
  // refused". A fake that resolves in a microtask cannot express it: `await banPublisher()`
  // then looks identical to never awaiting the writer at all, and BOTH of the mutations
  // that break the ordering (dropping the `await` inside the writer, and detaching the leg
  // from `toggleBan`'s awaited fan-out) pass a fully green suite. One tick, standing in for
  // a network round trip, is what makes them fail.
  const tick = () => new Promise((r) => setTimeout(r, 0));
  redisMock.redis.set.mockImplementation(async (key: string, value: string) => {
    await tick();
    store.set(key, value);
    return 'OK';
  });
  redisMock.redis.get.mockImplementation(async (key: string) => {
    await tick();
    return store.get(key) ?? null;
  });
  redisMock.redis.del.mockImplementation(async (key: string) => {
    await tick();
    return store.delete(key) ? 1 : 0;
  });

  isFliptMock.mockImplementation(async (flag: string) => flag === 'app-blocks-runtime-enabled');

  userUpdate.mockResolvedValue({ id: PUBLISHER_ID, paddleCustomerId: null });
  userFindFirst.mockResolvedValue(null);
  userLinkDeleteMany.mockResolvedValue({ count: 0 });
  imageUpdateMany.mockResolvedValue({ count: 0 });
  commentUpdateMany.mockResolvedValue({ count: 0 });
  commentV2UpdateMany.mockResolvedValue({ count: 0 });

  subscriptionFindMany.mockResolvedValue([
    ...PINNED.map(({ blockInstanceId }, i) => ({
      id: `bus_pinned_${i}`,
      scope: 'publisher_all_my_models',
      blockInstanceId,
    })),
    ...BLANKET.map(({ id, scope }) => ({ id, scope, blockInstanceId: null })),
  ]);
  appBlockFindMany.mockResolvedValue(OWNED_APP_BLOCK_IDS.map((id) => ({ id })));
  appBlockFindUnique.mockResolvedValue({ status: 'approved' });

  // Not currently banned — so `toggleBan` takes the BAN branch.
  userFindUnique.mockResolvedValue({
    bannedAt: null,
    meta: {},
    username: 'publisher',
    email: null,
  });
});

/**
 * AC-1. The headline claim, over a real minted token and a real bridge request.
 *
 * 🔴 This is the assertion that must be watched RED at the base commit: before the writer
 * existed, `toggleBan` wrote no marker and the request below was served 200 by the wrapped
 * handler.
 */
describe('AC-1 — a ban refuses the publisher’s already-minted token on its NEXT bridge request', () => {
  it('REST (`withBlockScope`): 403 `block instance revoked`, handler never runs', async () => {
    const token = await mint(PINNED[0].blockInstanceId, PINNED[0].blockId);

    // The token works BEFORE the ban. Without this half, a harness that refuses
    // everything would satisfy the assertion below while measuring nothing.
    const before = await driveRest(token);
    expect(before.res.statusCode, 'the token was already refused before the ban').toBe(200);
    expect(before.handler).toHaveBeenCalledTimes(1);

    await banPublisher();

    const after = await driveRest(token);
    expect(after.res.statusCode).toBe(403);
    expect(after.res.body).toEqual({ error: 'block instance revoked' });
    expect(after.handler).not.toHaveBeenCalled();
  });

  it('tRPC bridge (`authorizeBlockBridgeToken`): FORBIDDEN `block instance revoked`', async () => {
    const token = await mint(PINNED[0].blockInstanceId, PINNED[0].blockId);
    await expect(authorizeBlockBridgeToken(token)).resolves.toMatchObject({
      blockInstanceId: PINNED[0].blockInstanceId,
    });

    await banPublisher();

    await expect(authorizeBlockBridgeToken(token)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'block instance revoked',
    });
  });

  /**
   * The token itself is untouched — still signature-valid and unexpired. The refusal comes
   * from the marker, not from expiry, which is the whole point of the mechanism.
   */
  it('refuses a token that is still perfectly valid — not an expiry artefact', async () => {
    const token = await mint(PINNED[0].blockInstanceId, PINNED[0].blockId);
    await banPublisher();

    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    expect(payload.exp * 1000).toBeGreaterThan(Date.now());

    const { res } = await driveRest(token);
    expect(res.statusCode).toBe(403);
  });
});

/**
 * AC-2. The loop, not one row. Four live instances across two blocks: a writer that stops
 * after the first row fails on the second token, and one that stops after the first block
 * fails on the third.
 */
describe('AC-2 — EVERY live instance of EVERY block the publisher owns', () => {
  it('refuses all four PINNED tokens after one ban', async () => {
    const tokens = await Promise.all(
      PINNED.map(({ blockInstanceId, blockId, appBlockId }) =>
        mint(blockInstanceId, blockId, appBlockId)
      )
    );

    await banPublisher();

    const results = await Promise.all(tokens.map((t) => driveRest(t)));
    expect(
      results.map((r) => r.res.statusCode),
      'a partially-applied revocation — some of the publisher’s live instances are still serving'
    ).toEqual([403, 403, 403, 403]);
    for (const { handler } of results) expect(handler).not.toHaveBeenCalled();
  });

  /**
   * 🔴 THE REGRESSION FOR THE DEFECT THIS PR SHIPPED AND THEN FIXED. Four of the five
   * namespaces are SYNTHESISED, not stored: `bus_pub_*` / `bus_view_*` off a blanket
   * subscription's row id, `pdb_*` / `page_*` off the app block id. The first version of
   * the writer selected `blockInstanceId: { not: null }` and reached only the first
   * namespace, while every comment in the change said "every live instance".
   *
   * Each case below mints a REAL token carrying the synthesised id — which is exactly what
   * `listForModel` and the page mint hand a client — and drives a real bridge request.
   */
  it.each([
    ...BLANKET.map((b) => [b.instanceId, `blanket ${b.scope} subscription`] as const),
    ...APP_BLOCK_SURFACE_IDS.map(
      (id) =>
        [id, id.startsWith('pdb_') ? 'platform-default promotion' : 'full-page surface'] as const
    ),
  ])('refuses the SYNTHESISED id %s (%s)', async (instanceId) => {
    const token = await mint(instanceId, PINNED[0].blockId);

    const before = await driveRest(token);
    expect(before.res.statusCode, 'the token was already refused before the ban').toBe(200);

    await banPublisher();

    const after = await driveRest(token);
    expect(
      after.res.statusCode,
      `${instanceId} still authenticates after its publisher was banned — this namespace ` +
        `is not reached by revokeBlockInstancesForPublisher`
    ).toBe(403);
    expect(after.res.body).toEqual({ error: 'block instance revoked' });
  });

  /**
   * 🔴 THE WHOLE KEY SET, NOT A FILTERED SUBSET — and the filter is the trap. Written as
   * `[...store.keys()].filter(k => k.includes('618'))` this assertion is scoped to the
   * fixture's OWN ids, so a marker written for an instance the publisher does not own is
   * invisible to it. OVER-revocation is the hazard the ownership filter exists to prevent
   * (a ban on one account taking down another account's product), and a subset assertion
   * leaves the structural `where` check as its only detector. Measured: a mutant that
   * additionally revokes a foreign id SURVIVED the subset form.
   */
  it('wrote a marker for every instance id across all five namespaces, and for NO other', async () => {
    await banPublisher();

    const expected = ALL_INSTANCE_IDS.map(
      (id) => `${REDIS_KEYS.BLOCKS.REVOKED_INSTANCE}:${id}`
    ).sort();
    expect(
      [...store.keys()].sort(),
      'the revoked set does not equal the selected set — a missing key is an instance still ' +
        'serving, an extra key is a revocation against an app this ban was not about'
    ).toEqual(expected);
    // Pins the count independently of the key format, so a change to `revokedKey` fails as
    // a format mismatch rather than silently re-scoping what is being compared.
    expect(redisMock.redis.set).toHaveBeenCalledTimes(ALL_INSTANCE_IDS.length);
  });

  /**
   * 🔴 THE OWNERSHIP FILTER, ASSERTED AS A WHOLE `where` RATHER THAN A PARTIAL MATCH.
   * `app: { userId }` is the OWNER. Widening it to any app the banned user can reach would
   * let a ban on a seated collaborator revoke every live token of an app owned by somebody
   * who was not banned.
   *
   * 🔴 AND THERE IS NO `blockInstanceId` FILTER, WHICH IS THE POINT OF THE FIX. A
   * `{ not: null }` clause here is the defect: it drops every blanket subscription, whose
   * id is synthesised rather than stored.
   */
  it('selects by app OWNERSHIP, on the primary, over ALL subscription rows', async () => {
    await banPublisher();

    expect(subscriptionFindMany).toHaveBeenCalledTimes(1);
    expect(subscriptionFindMany.mock.calls[0][0]).toEqual({
      where: { appBlock: { app: { userId: PUBLISHER_ID } } },
      select: { id: true, scope: true, blockInstanceId: true },
    });
  });

  it('also enumerates the OWNED APP BLOCKS, which carry the two subscription-less surfaces', async () => {
    await banPublisher();

    expect(appBlockFindMany).toHaveBeenCalledTimes(1);
    expect(appBlockFindMany.mock.calls[0][0]).toEqual({
      where: { app: { userId: PUBLISHER_ID } },
      select: { id: true },
    });
  });

  /**
   * NEGATIVE CONTROL on the whole harness: a publisher with nothing live writes no marker
   * and its token is still served. Without this, every 403 above could be coming from
   * something other than the ban. BOTH reads must be emptied — emptying only the
   * subscription read would leave the app-block surfaces marked and the control would
   * silently stop being one.
   */
  it('a ban with nothing live writes nothing and refuses nothing', async () => {
    subscriptionFindMany.mockResolvedValue([]);
    appBlockFindMany.mockResolvedValue([]);
    const token = await mint(PINNED[0].blockInstanceId, PINNED[0].blockId);

    await banPublisher();

    expect([...store.keys()].filter((k) => k.includes('618'))).toEqual([]);
    const { res, handler } = await driveRest(token);
    expect(res.statusCode).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  /**
   * A scope the synthesiser does not recognise must produce NO marker rather than a guessed
   * prefix. A marker under an id no token carries refuses nothing and reads as coverage.
   */
  it('skips a subscription whose scope has no known synthesised id', async () => {
    subscriptionFindMany.mockResolvedValue([
      { id: 'bus_618_weird', scope: 'some_future_scope', blockInstanceId: null },
    ]);
    appBlockFindMany.mockResolvedValue([]);

    await banPublisher();

    expect([...store.keys()].filter((k) => k.includes('bus_618_weird'))).toEqual([]);
  });
});

/**
 * AC-3. Unbanning is not a resurrection. The markers are TTL-bound to one token lifetime
 * and re-minting is the recovery path, so the unban branch must not clear them — otherwise
 * a ban-then-immediate-unban hands the publisher back the exact tokens the ban refused.
 */
describe('AC-3 — unbanning does not clear the markers', () => {
  beforeEach(() => {
    // This call is the LIFT: the account is currently banned.
    userFindUnique.mockResolvedValue({
      bannedAt: ALREADY_BANNED_AT,
      meta: {},
      username: 'publisher',
      email: null,
    });
  });

  it('leaves an existing marker in place, and the old token stays refused', async () => {
    const token = await mint(PINNED[0].blockInstanceId, PINNED[0].blockId);
    // Markers as a prior ban would have left them.
    await revokeBlockInstancesForPublisher({ userId: PUBLISHER_ID });
    const markersBefore = [...store.keys()].filter((k) => k.includes('618'));
    expect(markersBefore.length).toBe(ALL_INSTANCE_IDS.length);

    await banPublisher(); // same entry point; `bannedAt` set ⇒ the UNBAN branch

    expect([...store.keys()].filter((k) => k.includes('618')).sort()).toEqual(markersBefore.sort());
    const { res } = await driveRest(token);
    expect(res.statusCode).toBe(403);
  });

  it('deletes no revocation key — the unban branch never calls `clearInstance`', async () => {
    await revokeBlockInstancesForPublisher({ userId: PUBLISHER_ID });
    redisMock.redis.del.mockClear();

    await banPublisher();

    const deleted = redisMock.redis.del.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((k: string) => k.includes('618'));
    expect(deleted, 'the unban branch cleared a revocation marker').toEqual([]);
  });

  it('does not enumerate the publisher’s instances at all on the unban branch', async () => {
    await banPublisher();
    expect(subscriptionFindMany).not.toHaveBeenCalled();
    expect(appBlockFindMany).not.toHaveBeenCalled();
  });
});

/**
 * 🔴 THE UNBAN BRANCH IS NOT THE ONLY WAY A MARKER GETS CLEARED, AND THE OTHER WAY IS
 * REACHABLE BY SOMEBODY THE BAN WAS NOT ABOUT.
 *
 * `BlockRevocation.clearInstance` is called unconditionally by `toggleEnabled(true)` and
 * by `installOnModel` on an existing row — both driven by the install's CONSUMER, i.e. the
 * model owner, a different and un-banned account. `blockInstanceId` survives a disable, so
 * without a cause on the marker, that consumer toggling the install off and on again
 * clears the BAN's marker and puts the banned publisher's tokens straight back into
 * service. AC-3 only covers the unban branch; this is the wider hole.
 */
describe('a ban marker is not clearable by an ordinary install path', () => {
  it('`clearInstance` refuses a ban marker but still clears an install marker', async () => {
    const banned = PINNED[0].blockInstanceId;
    const uninstalled = PINNED[1].blockInstanceId;

    await banPublisher();
    await BlockRevocation.revokeInstance(uninstalled); // no cause ⇒ the uninstall/toggle shape

    const keyOf = (id: string) => [...store.keys()].find((k) => k.endsWith(id))!;
    expect(store.get(keyOf(banned))).toBe('ban');
    expect(store.get(keyOf(uninstalled))).toBe('install');

    await BlockRevocation.clearInstance(banned);
    await BlockRevocation.clearInstance(uninstalled);

    // The pair is the point: if `clearInstance` had simply stopped working, the second
    // assertion would fail too and the first would be meaningless.
    expect(
      await BlockRevocation.isRevoked(banned),
      'an ordinary re-enable cleared a ban revocation'
    ).toBe(true);
    expect(
      await BlockRevocation.isRevoked(uninstalled),
      '`clearInstance` no longer clears the marker it was written for'
    ).toBe(false);
  });

  it('the banned publisher’s token is STILL refused after a consumer re-enable', async () => {
    const token = await mint(PINNED[0].blockInstanceId, PINNED[0].blockId);
    await banPublisher();
    await BlockRevocation.clearInstance(PINNED[0].blockInstanceId);

    expect((await driveRest(token)).res.statusCode).toBe(403);
  });

  /**
   * FAILS CLOSED on a read error — the opposite of `isRevoked`, deliberately. An
   * un-cleared marker expires on its own within one token lifetime; a wrongly-cleared ban
   * marker needs a second moderator action to restore.
   */
  it('clears nothing when the cause cannot be read', async () => {
    await BlockRevocation.revokeInstance(PINNED[1].blockInstanceId);
    redisMock.redis.get.mockRejectedValue(new Error('redis is down'));
    redisMock.redis.del.mockClear();

    await BlockRevocation.clearInstance(PINNED[1].blockInstanceId);

    expect(redisMock.redis.del).not.toHaveBeenCalled();
  });
});

/**
 * AC-5 is a NON-change (`isRevoked` still fails open on a Redis error), so it needs a live
 * assertion rather than a diff review: a Redis outage must not start 403ing every block.
 */
describe('AC-5 — `isRevoked` still FAILS OPEN on a Redis error', () => {
  it('serves the request when the marker read throws', async () => {
    const token = await mint(PINNED[0].blockInstanceId, PINNED[0].blockId);
    await banPublisher();
    expect((await driveRest(token)).res.statusCode).toBe(403);

    redisMock.redis.get.mockRejectedValue(new Error('redis is down'));
    const { res, handler } = await driveRest(token);
    expect(res.statusCode).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

/**
 * The ban must not be failable by this leg. `revokeInstance` swallows its own Redis errors;
 * this covers the DB read in front of it, which does not.
 */
describe('the writer can never fail a ban', () => {
  it('a failing instance lookup still completes the ban', async () => {
    subscriptionFindMany.mockRejectedValue(new Error('primary unreachable'));
    await expect(banPublisher()).resolves.toMatchObject({ id: PUBLISHER_ID });
  });

  it('a failing Redis write still completes the ban', async () => {
    redisMock.redis.set.mockRejectedValue(new Error('redis is down'));
    await expect(banPublisher()).resolves.toMatchObject({ id: PUBLISHER_ID });
  });
});
