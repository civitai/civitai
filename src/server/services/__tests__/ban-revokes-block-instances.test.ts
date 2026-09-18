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
 * 🔴 THE FIXTURE CARRIES FOUR INSTANCES ACROSS TWO BLOCKS, DELIBERATELY. A single-instance
 * fixture passes with a loop that revokes only its first row, which is the exact defect
 * this test is meant to be able to see.
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
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { withBlockScope } from '~/server/middleware/block-scope.middleware';
import { BlockTokenService } from '~/server/services/block-token.service';
import { authorizeBlockBridgeToken } from '~/server/services/blocks/block-bridge-auth.service';
import { revokeBlockInstancesForPublisher } from '~/server/services/blocks/publisher-ban-revocation.service';

const { toggleBan } = await import('~/server/services/user.service');
const { BanReasonCode } = await import('~/server/common/enums');

const PUBLISHER_ID = 90618;
const ACTOR_ID = 90619;
const ALREADY_BANNED_AT = new Date('2026-02-03T04:05:06.000Z');
const SCOPE = 'user:read:self';

/**
 * Two app blocks, two live instances each. `appBlockId` differs across the pair so a loop
 * that breaks after the first BLOCK is as visible as one that breaks after the first ROW.
 */
const FIXTURE = [
  { appBlockId: 'apb_618_one', blockId: 'blk_618_one', blockInstanceId: 'bki_618_one_a' },
  { appBlockId: 'apb_618_one', blockId: 'blk_618_one', blockInstanceId: 'bki_618_one_b' },
  { appBlockId: 'apb_618_two', blockId: 'blk_618_two', blockInstanceId: 'bki_618_two_a' },
  { appBlockId: 'apb_618_two', blockId: 'blk_618_two', blockInstanceId: 'bki_618_two_b' },
];
const APP_ID = 'app_618';

/** The in-memory Redis the marker is written into and read back out of. */
const store = new Map<string, string>();

const userFindUnique = dbMock.dbRead.user.findUnique;
const userUpdate = dbMock.dbWrite.user.update;
const userFindFirst = dbMock.dbWrite.user.findFirst;
const subscriptionFindMany = dbMock.dbWrite.blockUserSubscription.findMany;
const appBlockFindUnique = dbMock.dbRead.appBlock.findUnique;
// The ban fan-out chains `.catch` on each of these; an undeclared write verb returns
// `undefined` from the canonical mock and the fan-out then throws on `.catch`.
const userLinkDeleteMany = dbMock.dbWrite.userLink.deleteMany;
const imageUpdateMany = dbMock.dbWrite.image.updateMany;
const commentUpdateMany = dbMock.dbWrite.comment.updateMany;
const commentV2UpdateMany = dbMock.dbWrite.commentV2.updateMany;

async function mint(blockInstanceId: string, blockId: string): Promise<string> {
  const { token } = await BlockTokenService.sign({
    userId: 7,
    blockId,
    appId: APP_ID,
    appBlockId: 'apb_618_one',
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
  redisMock.redis.set.mockImplementation(async (key: string, value: string) => {
    store.set(key, value);
    return 'OK';
  });
  redisMock.redis.get.mockImplementation(async (key: string) => store.get(key) ?? null);
  redisMock.redis.del.mockImplementation(async (key: string) => (store.delete(key) ? 1 : 0));

  isFliptMock.mockImplementation(async (flag: string) => flag === 'app-blocks-runtime-enabled');

  userUpdate.mockResolvedValue({ id: PUBLISHER_ID, paddleCustomerId: null });
  userFindFirst.mockResolvedValue(null);
  userLinkDeleteMany.mockResolvedValue({ count: 0 });
  imageUpdateMany.mockResolvedValue({ count: 0 });
  commentUpdateMany.mockResolvedValue({ count: 0 });
  commentV2UpdateMany.mockResolvedValue({ count: 0 });

  subscriptionFindMany.mockResolvedValue(
    FIXTURE.map(({ blockInstanceId }) => ({ blockInstanceId }))
  );
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
    const token = await mint(FIXTURE[0].blockInstanceId, FIXTURE[0].blockId);

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
    const token = await mint(FIXTURE[0].blockInstanceId, FIXTURE[0].blockId);
    await expect(authorizeBlockBridgeToken(token)).resolves.toMatchObject({
      blockInstanceId: FIXTURE[0].blockInstanceId,
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
    const token = await mint(FIXTURE[0].blockInstanceId, FIXTURE[0].blockId);
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
  it('refuses all four tokens after one ban', async () => {
    const tokens = await Promise.all(
      FIXTURE.map(({ blockInstanceId, blockId }) => mint(blockInstanceId, blockId))
    );

    await banPublisher();

    const results = await Promise.all(tokens.map((t) => driveRest(t)));
    expect(
      results.map((r) => r.res.statusCode),
      'a partially-applied revocation — some of the publisher’s live instances are still serving'
    ).toEqual([403, 403, 403, 403]);
    for (const { handler } of results) expect(handler).not.toHaveBeenCalled();
  });

  it('wrote a marker for each instance id, and for no other', async () => {
    await banPublisher();

    const markers = [...store.keys()].filter((k) => k.includes('bki_618'));
    expect(markers.length).toBe(FIXTURE.length);
    for (const { blockInstanceId } of FIXTURE) {
      expect(
        markers.some((k) => k.endsWith(blockInstanceId)),
        `no revocation marker written for ${blockInstanceId}`
      ).toBe(true);
    }
  });

  /**
   * 🔴 THE OWNERSHIP FILTER, ASSERTED AS A WHOLE `where` RATHER THAN A PARTIAL MATCH.
   * `app: { userId }` is the OWNER. Widening it to any app the banned user can reach would
   * let a ban on a seated collaborator revoke every live token of an app owned by somebody
   * who was not banned. The `blockInstanceId: { not: null }` half keeps blanket
   * subscriptions — which synthesise their id on read — out of the set.
   */
  it('selects by app OWNERSHIP, on the primary, and only rows carrying a stored instance id', async () => {
    await banPublisher();

    expect(subscriptionFindMany).toHaveBeenCalledTimes(1);
    expect(subscriptionFindMany.mock.calls[0][0]).toEqual({
      where: {
        blockInstanceId: { not: null },
        appBlock: { app: { userId: PUBLISHER_ID } },
      },
      select: { blockInstanceId: true },
    });
  });

  /**
   * NEGATIVE CONTROL on the whole harness: a publisher with no live instances writes no
   * marker and its token is still served. Without this, every 403 above could be coming
   * from something other than the ban.
   */
  it('a ban with no live instances writes nothing and refuses nothing', async () => {
    subscriptionFindMany.mockResolvedValue([]);
    const token = await mint(FIXTURE[0].blockInstanceId, FIXTURE[0].blockId);

    await banPublisher();

    expect([...store.keys()].filter((k) => k.includes('bki_618'))).toEqual([]);
    const { res, handler } = await driveRest(token);
    expect(res.statusCode).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
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
    const token = await mint(FIXTURE[0].blockInstanceId, FIXTURE[0].blockId);
    // Markers as a prior ban would have left them.
    await revokeBlockInstancesForPublisher({ userId: PUBLISHER_ID });
    const markersBefore = [...store.keys()].filter((k) => k.includes('bki_618'));
    expect(markersBefore.length).toBe(FIXTURE.length);

    await banPublisher(); // same entry point; `bannedAt` set ⇒ the UNBAN branch

    expect([...store.keys()].filter((k) => k.includes('bki_618')).sort()).toEqual(
      markersBefore.sort()
    );
    const { res } = await driveRest(token);
    expect(res.statusCode).toBe(403);
  });

  it('deletes no revocation key — the unban branch never calls `clearInstance`', async () => {
    await revokeBlockInstancesForPublisher({ userId: PUBLISHER_ID });
    redisMock.redis.del.mockClear();

    await banPublisher();

    const deleted = redisMock.redis.del.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((k: string) => k.includes('bki_618'));
    expect(deleted, 'the unban branch cleared a revocation marker').toEqual([]);
  });

  it('does not enumerate the publisher’s instances at all on the unban branch', async () => {
    await banPublisher();
    expect(subscriptionFindMany).not.toHaveBeenCalled();
  });
});

/**
 * AC-5 is a NON-change (`isRevoked` still fails open on a Redis error), so it needs a live
 * assertion rather than a diff review: a Redis outage must not start 403ing every block.
 */
describe('AC-5 — `isRevoked` still FAILS OPEN on a Redis error', () => {
  it('serves the request when the marker read throws', async () => {
    const token = await mint(FIXTURE[0].blockInstanceId, FIXTURE[0].blockId);
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
