import { beforeEach, describe, expect, it, vi } from 'vitest';
// Setup-order import: installs the ~/env/server mock with the real test RSA keypair
// BEFORE block-token.service evaluates env at module load (same posture as the other
// real-JWT suites in src/server/middleware/__tests__).
import '~/__tests__/setup';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * 🔴 THE SEAM TEST — the one that had no owner.
 *
 * Every other suite around these two routes tests ONE side of the wrapper join and is
 * structurally unable to see the other. `tip-endpoint.test.ts` and
 * `collection-follow-endpoint.test.ts` both `vi.mock('~/server/middleware/
 * block-scope.middleware')` with a stub that simply stamps `req.blockClaims` and calls
 * through — so no middleware gate exists in those suites AT ALL, and a gate could be
 * deleted from the middleware without either of them moving. The middleware's own suites
 * (`block-scope.*.test.ts`) run the real middleware but wrap a `vi.fn()`, so they cannot
 * say which real route inherits anything.
 *
 * This file loads the REAL route modules — `withBlockScope(baseHandler, …)` as the page
 * actually exports it — and drives them with the REAL middleware and a REAL minted RS256
 * block JWT. It is the only place in the repo where "a suspended app cannot spend Buzz"
 * is a single assertion rather than two half-claims about different objects.
 *
 * The two routes chosen are the two with a genuine SIDE EFFECT behind the wrapper:
 *   - `POST /api/v1/blocks/tip`                    → a real Buzz transfer.
 *   - `POST /api/v1/blocks/collections/:id/follow` → a CollectionContributor write.
 *
 * Both assertions are the same shape and both halves matter: the response is the gate's
 * own 403, AND the money/write service was never called. Asserting only the status would
 * pass against a route that charged the user and then 403'd.
 */

const { isFliptMock, isRevokedMock } = vi.hoisted(() => ({
  isFliptMock: vi.fn(async (flag: string) => flag === 'app-blocks-runtime-enabled'),
  isRevokedMock: vi.fn(async () => false),
}));

// Runtime verification flag ON — otherwise the middleware treats a present block JWT as
// absent and falls through, which would make every assertion below vacuous.
vi.mock('~/server/flipt/client', () => ({ isFlipt: isFliptMock }));
// NOT revoked: a moderator suspension writes no revocation marker, and stubbing this to
// `true` would let the revocation check refuse first and prove nothing about approval.
vi.mock('~/server/services/block-revocation.service', () => ({
  BlockRevocation: { isRevoked: isRevokedMock },
}));

// ── the SIDE EFFECTS. Each is a spy that must never be reached. ──────────────────────
const { mockTipTransaction, mockAddContributor, mockRemoveContributor, mockPermissions } =
  vi.hoisted(() => ({
    mockTipTransaction: vi.fn(),
    mockAddContributor: vi.fn(),
    mockRemoveContributor: vi.fn(),
    mockPermissions: vi.fn(),
  }));
vi.mock('~/server/controllers/buzz.controller', () => ({
  createBuzzTipTransactionHandler: mockTipTransaction,
}));
vi.mock('~/server/services/collection.service', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  addContributorToCollection: mockAddContributor,
  removeContributorFromCollection: mockRemoveContributor,
  getUserCollectionPermissionsById: mockPermissions,
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: unknown) => h }));

/**
 * 🔴 THE LIMITERS ARE STUBBED OPEN, AND NOT FOR CONVENIENCE — without this the positive
 * control is inert. `block-tip-rate-limit` fails CLOSED on a Redis error (it is a money
 * path), and there is no Redis here, so the approved-app request returned 429 and never
 * reached `createBuzzTipTransactionHandler` at all. That made both arms of the pair
 * "the transfer was not called" — the suspended arm would have passed against a gate
 * that did not exist. Stubbing the limiter open is what makes the transfer REACHABLE on
 * the approved arm, which is the only thing that turns `not.toHaveBeenCalled()` on the
 * suspended arm into a statement about the gate.
 */
vi.mock('~/server/utils/block-tip-rate-limit', () => ({
  BLOCK_TIP_CAP_PER_DAY: 100_000,
  BLOCK_TIP_MAX_PER_TIP: 50_000,
  checkBlockTipRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
  reserveBlockTipSpend: vi.fn(async () => ({ key: 'k', total: 1 })),
  refundBlockTipSpend: vi.fn(async () => undefined),
  claimTipIdempotency: vi.fn(async () => ({ state: 'acquired', key: 'k' })),
  finalizeTipIdempotency: vi.fn(async () => undefined),
  releaseTipIdempotency: vi.fn(async () => undefined),
  computeTipFingerprint: vi.fn(() => 'fp'),
}));
vi.mock('~/server/services/blocks/block-collections.service', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  hydrateBlockSubject: vi.fn(async () => ({ id: 42, bannedAt: null, muted: false })),
}));
vi.mock('~/server/clickhouse/client', () => ({ Tracker: class {} }));

import { dbMock } from '~/__tests__/mocks';
import { BlockTokenService } from '~/server/services/block-token.service';
import tipRoute from '~/pages/api/v1/blocks/tip';
import followRoute from '~/pages/api/v1/blocks/collections/[id]/follow';

/**
 * `~/server/db/client` is mocked GLOBALLY by `~/__tests__/setup` — a per-file `vi.mock`
 * of it is a guarded specifier (`no-direct-shared-module-mock`). Behaviour is declared
 * through the canonical handle.
 */
const findUniqueMock = dbMock.dbRead.appBlock.findUnique;

const APP_ID = 'app_seam';
const BLOCK_ID = 'blk_seam';

async function mintToken(scopes: string[]): Promise<string> {
  const { token } = await BlockTokenService.sign({
    userId: 42,
    blockId: BLOCK_ID,
    appId: APP_ID,
    appBlockId: 'apb_seam',
    blockInstanceId: 'bki_seam',
    scopes,
    ctx: {},
  });
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

function makeReq(token: string, body: unknown, query: Record<string, string> = {}) {
  return {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    query,
    body,
    url: '/api/v1/blocks/tip',
    socket: { remoteAddress: '203.0.113.7' },
  } as unknown as NextApiRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` does not reach the canonical db mock's hybrid-proxy nodes.
  findUniqueMock.mockReset();
  dbMock.dbRead.user.findUnique.mockResolvedValue({ id: 77, deletedAt: null });
  isFliptMock.mockImplementation(async (flag: string) => flag === 'app-blocks-runtime-enabled');
  isRevokedMock.mockImplementation(async () => false);
  // Set here, not per-test: a side-effect spy that RESOLVES means the base-revision run
  // of the refusal cases below fails on the call-count assertion (the real defect) rather
  // than on a 500 from an unstubbed return value (an artefact of the fixture).
  mockTipTransaction.mockResolvedValue({ dedupedAmount: 0 });
  mockPermissions.mockResolvedValue({ read: true, follow: true, manage: false });
  mockAddContributor.mockResolvedValue(undefined);
  mockRemoveContributor.mockResolvedValue(undefined);
});

describe('a SUSPENDED app is refused on the REST routes that can spend or write', () => {
  it('POST /api/v1/blocks/tip — 403, and the Buzz transfer is never attempted', async () => {
    findUniqueMock.mockResolvedValue({ status: 'suspended' });
    const token = await mintToken(['social:tip:self']);
    const res = makeRes();

    await (tipRoute as unknown as (req: NextApiRequest, res: NextApiResponse) => Promise<void>)(
      makeReq(token, { toUserId: 77, amount: 100 }),
      res
    );

    // 🔴 ASSERTED FIRST, deliberately. This is the half that makes it a money claim
    // rather than a status claim, and putting it first means a regression reports "the
    // Buzz transfer ran" instead of reporting whatever status the unguarded path
    // happened to produce.
    expect(mockTipTransaction).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    // Whole normalised body, not a substring: `toContain('not approved')` would also be
    // satisfied by a DIFFERENT refusal that happens to share the phrase.
    expect(res.body).toEqual({ error: 'app block is not approved' });
  });

  it('POST /api/v1/blocks/collections/:id/follow — 403, and no contributor row is touched', async () => {
    findUniqueMock.mockResolvedValue({ status: 'suspended' });
    const token = await mintToken(['collections:write:self']);
    const res = makeRes();

    await (followRoute as unknown as (req: NextApiRequest, res: NextApiResponse) => Promise<void>)(
      makeReq(token, { follow: true }, { id: '99' }),
      res
    );

    expect(mockAddContributor).not.toHaveBeenCalled();
    expect(mockRemoveContributor).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'app block is not approved' });
  });

  /**
   * 🔴 THE POSITIVE CONTROL, and it is doing more work than it looks like.
   *
   * Without it, both assertions above are satisfied by a route that refuses EVERYTHING —
   * a broken import, a 403 from some unrelated guard, a mint that silently produced a
   * token nothing accepts. The only way to tell "the gate refused a suspended app" from
   * "nothing ever gets through here" is to flip the single variable under test and watch
   * the same request reach the service call.
   */
  it('POSITIVE CONTROL — the SAME request on an APPROVED app REACHES the Buzz transfer', async () => {
    findUniqueMock.mockResolvedValue({ status: 'approved' });
    const token = await mintToken(['social:tip:self']);
    const res = makeRes();

    await (tipRoute as unknown as (req: NextApiRequest, res: NextApiResponse) => Promise<void>)(
      makeReq(token, { toUserId: 77, amount: 100 }),
      res
    );

    // Report the PAIR, never the zero alone: 1 call here against 0 under test. Only the
    // app's status differs between this case and the first one, so this is what makes
    // that `not.toHaveBeenCalled()` a claim about the gate rather than about the fixture.
    expect(mockTipTransaction).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });

  /**
   * 🔴 THE `not_found` POLICY, AT THE ROUTE, AND IT IS THE SHARP END OF IT: a token whose
   * `(appId, blockId)` resolves to NO `app_blocks` row can still spend Buzz.
   *
   * That is the decision, stated where it costs something rather than only in a docblock.
   * The reasoning: every moderator takedown leaves a row with `status !== 'approved'`, so
   * the whole of this gate's value is the `not_approved` case above. A missing row is not
   * a takedown — it is a row deleted or re-keyed mid-session, blockId drift, or an
   * id-minting bug — i.e. a HEALTHY app, and refusing it would 404 a live public endpoint
   * with no toggle to pull. It is counted and logged instead, so the false-positive rate
   * is observable rather than inferred from support tickets.
   *
   * It is pinned HERE, on the money route, because this is the assertion whose failure a
   * future author must read before widening the gate back over this branch.
   */
  it('NO app_blocks ROW on /tip — SERVED, and the Buzz transfer runs', async () => {
    findUniqueMock.mockResolvedValue(null);
    const token = await mintToken(['social:tip:self']);
    const res = makeRes();

    await (tipRoute as unknown as (req: NextApiRequest, res: NextApiResponse) => Promise<void>)(
      makeReq(token, { toUserId: 77, amount: 100 }),
      res
    );

    expect(mockTipTransaction).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });

  it('POSITIVE CONTROL — the SAME follow on an APPROVED app REACHES the contributor write', async () => {
    findUniqueMock.mockResolvedValue({ status: 'approved' });
    const token = await mintToken(['collections:write:self']);
    const res = makeRes();

    await (followRoute as unknown as (req: NextApiRequest, res: NextApiResponse) => Promise<void>)(
      makeReq(token, { follow: true }, { id: '99' }),
      res
    );

    expect(mockAddContributor).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });
});
