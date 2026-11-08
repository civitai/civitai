import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { BuzzApiError } from '@civitai/buzz';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type {
  BlockFeeAccrualRecord,
  BlockSpendRecord,
  BlockWorkflowRecord,
  OrchestratorWorkflowCharges,
} from '~/server/services/blocks/app-workflow-refund.data';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * `/api/mod/apps/refund-workflows`: a moderator refunds the Buzz App Blocks generations charged a
 * user — each generation leg in its original colour, and the app author's fee.
 *
 * WHAT IS REAL AND WHAT IS NOT. The endpoint wrapper, the refund service, the idempotent Buzz wrapper
 * (`refundTransactionOnce`) and the author-fee reversal (`reverseBlockAuthorFee`,
 * `refundBlockAuthorFee`) all run for real. Mocked at their module boundaries: the Buzz service —
 * the seam `buzz-prefix-refund.test.ts` mocks — backed by an in-memory ledger keyed by external id,
 * so a refund this file makes is visible to the next read exactly as on the real ledger; the
 * platform's own tables and the orchestrator read (`app-workflow-refund.data`), as fixtures; Prisma's
 * `blockAuthorFeeAccrual` (for the real reversal); feedback; notifications.
 *
 * 🔴 SO NO SQL RUNS HERE. The statements in `app-workflow-refund.data.ts` are not exercised by this
 * file, and a green run is not a claim that they work against a database.
 *
 * Every fixture amount is distinct from every other and from the 5,000 cap, so an assertion on a sum
 * cannot pass by adding the wrong legs.
 */

const h = vi.hoisted(() => ({
  session: { user: {} as Record<string, unknown> },
  bearer: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => null),
  audit: vi.fn(),
  hasModeratorGrant: vi.fn<(...a: unknown[]) => Promise<boolean>>(async () => true),
  getTransactionByExternalId: vi.fn<(id: string) => Promise<unknown>>(),
  refundTransaction: vi.fn<(...a: unknown[]) => Promise<{ transactionId: string }>>(),
  createBuzzTransactionMany: vi.fn<(rows: Record<string, unknown>[]) => Promise<unknown>>(),
  getAppWorkflowRecords: vi.fn<(ids: string[]) => Promise<unknown>>(),
  getOrchestratorWorkflowCharges: vi.fn<(id: string) => Promise<unknown>>(),
  getAppNames: vi.fn<(ids: string[]) => Promise<Map<string, string>>>(),
  getAppFeedbackForRefund: vi.fn<(id: number) => Promise<unknown>>(),
  modResolveAppFeedbackWithRefund: vi.fn<(a: Record<string, unknown>) => Promise<boolean>>(),
  createNotification: vi.fn<(a: Record<string, unknown>) => Promise<void>>(),
}));

vi.mock('~/server/auth/bearer-token', () => ({
  getSessionFromBearerToken: (...a: unknown[]) => h.bearer(...a),
}));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => h.session),
}));
vi.mock('~/server/clickhouse/client', () => ({
  Tracker: class {
    retoolAudit = h.audit;
  },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  handleEndpointError: (
    res: { status: (n: number) => { json: (b: unknown) => unknown } },
    e: unknown
  ) => {
    const status = e instanceof TRPCError ? getHTTPStatusCodeFromError(e) : 500;
    return res
      .status(status)
      .json({ error: (e as { code?: string }).code ?? 'error', message: (e as Error).message });
  },
}));
vi.mock('~/server/services/moderator-grants', () => ({
  hasModeratorGrant: (...a: unknown[]) => h.hasModeratorGrant(...a),
}));
vi.mock('~/server/services/buzz.service', () => ({
  getTransactionByExternalId: (id: string) => h.getTransactionByExternalId(id),
  refundTransaction: (...a: unknown[]) => h.refundTransaction(...a),
  createBuzzTransactionMany: (rows: Record<string, unknown>[]) => h.createBuzzTransactionMany(rows),
  getMultiAccountTransactionsByPrefix: vi.fn(),
  refundMultiAccountTransaction: vi.fn(),
}));
vi.mock('~/server/services/blocks/app-workflow-refund.data', () => ({
  getAppWorkflowRecords: (ids: string[]) => h.getAppWorkflowRecords(ids),
  getOrchestratorWorkflowCharges: (id: string) => h.getOrchestratorWorkflowCharges(id),
  getAppNames: (ids: string[]) => h.getAppNames(ids),
  listAppWorkflowIdsForUser: vi.fn(),
  resolveListingAppBlockId: vi.fn(),
}));
vi.mock('~/server/services/blocks/app-feedback.service', () => ({
  getAppFeedbackForRefund: (id: number) => h.getAppFeedbackForRefund(id),
  modResolveAppFeedbackWithRefund: (a: Record<string, unknown>) =>
    h.modResolveAppFeedbackWithRefund(a),
}));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: (a: Record<string, unknown>) => h.createNotification(a),
}));
// The author-fee rail's counters and flag, mocked as its own suite mocks them.
vi.mock('~/server/prom/client', () => ({
  blockAuthorFeeQuotedCounter: { inc: vi.fn() },
  blockAuthorFeeChargedCounter: { inc: vi.fn() },
  blockAuthorFeeBaseBuzzCounter: { inc: vi.fn() },
  blockAuthorFeeBuzzCounter: { inc: vi.fn() },
  blockAuthorFeeObservedCounter: { inc: vi.fn() },
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksAuthorFeeEnabled: vi.fn(async () => true),
}));

import handler from '~/pages/api/mod/apps/refund-workflows';

// ─── Fixtures ───────────────────────────────────────────────────────────────

// Noon UTC: the accrual day of `TODAY` is still open; `YESTERDAY`'s has closed.
const NOW = new Date('2026-11-07T12:00:00.000Z');
const TODAY = new Date('2026-11-07T09:30:00.000Z');
const YESTERDAY = new Date('2026-11-06T15:45:00.000Z');

const MODERATOR = 990000007;
const VIEWER = 70411;
const OTHER_VIEWER = 70523;
const OWNER = 70637;
const APP = 'apb_refund_alpha';
const OTHER_APP = 'apb_refund_beta';
const APP_NAME = 'Sample Refund App';
const REASON = 'Generation succeeded but no image reached the user.';

const txId = (n: number) => `5a1e0c3d-0000-4000-8000-${String(n).padStart(12, '0')}`;
const feeChargeKey = (wf: string) => `block-author-fee-charge-${wf}`;
const feeReversalKey = (wf: string) => `block-author-fee-reversal-${wf}`;

type LedgerRow = {
  fromAccountId: number;
  toAccountId: number;
  fromAccountType: string;
  toAccountType: string;
  amount: number;
  externalTransactionId?: string;
};

type Leg = { n: number; amount: number; colour: string };
type FeeFixture = {
  /** `settled`: status flipped (accrued today). `settled-by-day`: still `accrued`, day closed. */
  state: 'unsettled' | 'settled' | 'settled-by-day' | 'unaccrued' | 'reversed';
  amount: number;
  colour: string;
};

let world: {
  workflows: BlockWorkflowRecord[];
  spends: BlockSpendRecord[];
  fees: BlockFeeAccrualRecord[];
  orchestrator: Map<string, OrchestratorWorkflowCharges | Error>;
  ledger: Map<string, LedgerRow>;
  legPayer: Map<string, { userId: number; colour: string; amount: number }>;
  failRefund: Set<string>;
  /** Buzz answers a repeat refund 200 (today's behaviour) instead of 409. */
  repeat200: boolean;
  feedback: Map<number, { id: number; area: string; userId: number; appBlockId: string | null }>;
};

function addWorkflow(opts: {
  id: string;
  userId?: number;
  appBlockId?: string;
  status?: string;
  legs?: Leg[];
  credits?: { amount: number; colour: string }[];
  fee?: FeeFixture;
  /** Debits whose id is not a Buzz transaction id (a fund-backed workflow). */
  rawDebitIds?: string[];
}) {
  const userId = opts.userId ?? VIEWER;
  const appBlockId = opts.appBlockId ?? APP;
  const legs = opts.legs ?? [];
  world.workflows.push({
    workflowId: opts.id,
    userId,
    appBlockId,
    status: opts.status ?? 'succeeded',
    submittedAt: TODAY,
  });
  world.spends.push({
    workflowId: opts.id,
    userId,
    appBlockId,
    buzzAmount: legs.reduce((sum, l) => sum + l.amount, 0),
    status: 'tracked',
    attributedAt: TODAY,
  });
  world.orchestrator.set(opts.id, {
    found: true,
    status: opts.status ?? 'succeeded',
    transactions: [
      ...legs.map((l) => ({
        type: 'debit',
        amount: l.amount,
        id: txId(l.n),
        accountType: l.colour,
      })),
      ...(opts.rawDebitIds ?? []).map((id) => ({
        type: 'debit',
        amount: 7,
        id,
        accountType: 'yellow',
      })),
      ...(opts.credits ?? []).map((c, i) => ({
        type: 'credit',
        amount: c.amount,
        id: `credit-${opts.id}-${i}`,
        accountType: c.colour,
      })),
    ],
  });
  for (const l of legs)
    world.legPayer.set(txId(l.n), { userId, colour: l.colour, amount: l.amount });

  const fee = opts.fee;
  if (!fee) return;
  world.ledger.set(feeChargeKey(opts.id), {
    fromAccountId: userId,
    toAccountId: 0,
    fromAccountType: fee.colour,
    toAccountType: fee.colour,
    amount: fee.amount,
  });
  if (fee.state === 'reversed') {
    world.ledger.set(feeReversalKey(opts.id), {
      fromAccountId: 0,
      toAccountId: userId,
      fromAccountType: fee.colour,
      toAccountType: fee.colour,
      amount: fee.amount,
    });
    return;
  }
  if (fee.state === 'unaccrued') return;
  world.fees.push({
    workflowId: opts.id,
    viewerUserId: userId,
    appBlockId,
    appOwnerUserId: OWNER,
    status: fee.state === 'settled' ? 'settled' : 'accrued',
    feeBuzz: fee.amount,
    buzzType: fee.colour,
    // `settled` is flipped TODAY, so only its status word says settled; `settled-by-day` still
    // reads `accrued`, so only its day does. Each pins one half of the reversibility test.
    accruedAt: fee.state === 'settled-by-day' ? YESTERDAY : TODAY,
  });
}

/** A refund already on the ledger for leg `n`, as an earlier call would have left it. */
function alreadyRefunded(n: number) {
  const payer = world.legPayer.get(txId(n))!;
  world.ledger.set(`refund-${txId(n)}`, {
    fromAccountId: 0,
    toAccountId: payer.userId,
    fromAccountType: payer.colour,
    toAccountType: payer.colour,
    amount: payer.amount,
  });
}

const conflict = () =>
  new TRPCError({ code: 'CONFLICT', message: 'ledger', cause: new BuzzApiError(409, 'dup') });

function installWorld() {
  h.getAppWorkflowRecords.mockImplementation(async (ids) => ({
    workflows: world.workflows.filter((r) => ids.includes(r.workflowId)),
    spends: world.spends.filter((r) => ids.includes(r.workflowId)),
    fees: world.fees.filter((r) => ids.includes(r.workflowId)),
  }));
  h.getOrchestratorWorkflowCharges.mockImplementation(async (id) => {
    const found = world.orchestrator.get(id);
    if (found instanceof Error) throw found;
    return found ?? { found: false };
  });
  h.getAppNames.mockImplementation(
    async (ids) =>
      new Map(ids.map((id): [string, string] => [id, id === APP ? APP_NAME : `name of ${id}`]))
  );
  h.getTransactionByExternalId.mockImplementation(async (id) => world.ledger.get(id) ?? null);
  h.refundTransaction.mockImplementation(async (id) => {
    const transactionId = id as string;
    if (world.failRefund.has(transactionId)) throw new Error('Buzz service unavailable');
    if (world.ledger.has(`refund-${transactionId}`)) {
      if (world.repeat200) return { transactionId };
      throw conflict();
    }
    const payer = world.legPayer.get(transactionId)!;
    world.ledger.set(`refund-${transactionId}`, {
      fromAccountId: 0,
      toAccountId: payer.userId,
      fromAccountType: payer.colour,
      toAccountType: payer.colour,
      amount: payer.amount,
    });
    return { transactionId };
  });
  h.createBuzzTransactionMany.mockImplementation(async (rows) => {
    const transactions: string[] = [];
    const conflicts: string[] = [];
    for (const row of rows) {
      const key = row.externalTransactionId as string;
      if (world.ledger.has(key)) conflicts.push(key);
      else {
        world.ledger.set(key, row as unknown as LedgerRow);
        transactions.push(key);
      }
    }
    return { transactions, conflicts };
  });
  h.getAppFeedbackForRefund.mockImplementation(async (id) => world.feedback.get(id) ?? null);
  h.modResolveAppFeedbackWithRefund.mockResolvedValue(true);
  h.createNotification.mockResolvedValue(undefined);

  // The real reversal reads and claims the accrual row through Prisma.
  dbMock.dbWrite.blockAuthorFeeAccrual.findUnique.mockImplementation(
    async ({ where }: { where: { workflowId: string } }) => {
      const row = world.fees.find((f) => f.workflowId === where.workflowId);
      return row
        ? {
            id: `acc_${row.workflowId}`,
            status: row.status,
            viewerUserId: row.viewerUserId,
            buzzType: row.buzzType,
            feeBuzz: row.feeBuzz,
            accruedAt: row.accruedAt,
          }
        : null;
    }
  );
  dbMock.dbWrite.blockAuthorFeeAccrual.deleteMany.mockImplementation(
    async ({
      where,
    }: {
      where: { workflowId: string; status: string; accruedAt: { gte: Date } };
    }) => {
      const i = world.fees.findIndex(
        (f) =>
          f.workflowId === where.workflowId &&
          f.status === where.status &&
          f.accruedAt.getTime() >= where.accruedAt.gte.getTime()
      );
      if (i < 0) return { count: 0 };
      world.fees.splice(i, 1);
      return { count: 1 };
    }
  );
}

function call(
  body: Record<string, unknown>,
  { method = 'POST', headers = {} }: { method?: string; headers?: Record<string, string> } = {}
) {
  const req = { method, headers, body, query: {} } as unknown as Parameters<typeof handler>[0];
  let status = 200;
  let payload: any;
  const res = {
    status(c: number) {
      status = c;
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
  return (handler(req, res) as Promise<unknown>).then(() => ({ status, body: payload }));
}

const refund = (workflowIds: string[], extra: Record<string, unknown> = {}) =>
  call({ workflowIds, reason: REASON, execute: true, ...extra });
const dryRun = (workflowIds: string[], extra: Record<string, unknown> = {}) =>
  call({ workflowIds, reason: REASON, ...extra });

const holds = (...ids: string[]) =>
  h.hasModeratorGrant.mockImplementation(async (_actor, id) => ids.includes(id as string));

/** Runs `between` after the plan is made and before any money moves (the first read execute makes). */
const betweenPlanAndExecute = (between: () => void) =>
  h.getAppNames.mockImplementationOnce(async (ids) => {
    between();
    return new Map(ids.map((id): [string, string] => [id, APP_NAME]));
  });

/** Every way this endpoint can move money. */
function expectNoMoneyMoved() {
  expect(h.refundTransaction).not.toHaveBeenCalled();
  expect(h.createBuzzTransactionMany).not.toHaveBeenCalled();
  expect(dbMock.dbWrite.blockAuthorFeeAccrual.deleteMany).not.toHaveBeenCalled();
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.clearAllMocks();
  world = {
    workflows: [],
    spends: [],
    fees: [],
    orchestrator: new Map(),
    ledger: new Map(),
    legPayer: new Map(),
    failRefund: new Set(),
    repeat200: false,
    feedback: new Map(),
  };
  installWorld();
  h.session.user = { id: MODERATOR, isModerator: true, permissions: [], bannedAt: null };
  h.bearer.mockResolvedValue(null);
  holds('apps.buzz.refund');
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  redisMock.sysRedis.ttl.mockResolvedValue(60);
});

// ─── Who may call it ────────────────────────────────────────────────────────

describe('who may call it', () => {
  beforeEach(() => addWorkflow({ id: 'wf-auth', legs: [{ n: 1, amount: 137, colour: 'yellow' }] }));

  it('refuses a signed-in non-moderator before planning anything', async () => {
    h.session.user = { id: VIEWER, isModerator: false, permissions: [], bannedAt: null };
    const { status } = await refund(['wf-auth']);
    expect(status).toBe(403);
    expect(h.getAppWorkflowRecords).not.toHaveBeenCalled();
    expectNoMoneyMoved();
  });

  it('refuses a moderator without apps.buzz.refund, dry run included', async () => {
    holds();
    for (const send of [refund, dryRun]) {
      const { status, body } = await send(['wf-auth']);
      expect(status).toBe(403);
      expect(body.message).toContain('apps.buzz.refund');
    }
    expect(h.hasModeratorGrant).toHaveBeenCalledWith(
      expect.objectContaining({ id: MODERATOR }),
      'apps.buzz.refund'
    );
    expect(h.getAppWorkflowRecords).not.toHaveBeenCalled();
    expectNoMoneyMoved();
  });

  it('refuses a holder of only the large grant — it widens the ordinary one, never stands in', async () => {
    holds('apps.buzz.refund.large');
    const { status } = await refund(['wf-auth']);
    expect(status).toBe(403);
    expectNoMoneyMoved();
  });

  it('control: a moderator holding apps.buzz.refund reaches the refund', async () => {
    const { status, body } = await refund(['wf-auth']);
    expect(status).toBe(200);
    expect(body.workflows[0].outcome).toBe('refunded');
    expect(h.refundTransaction).toHaveBeenCalledTimes(1);
  });

  it('refuses GET', async () => {
    const { status } = await call({ workflowIds: ['wf-auth'], reason: REASON }, { method: 'GET' });
    expect(status).toBe(405);
    expectNoMoneyMoved();
  });

  describe('API key path', () => {
    const keySession = (tokenScope: number) => ({
      user: { id: MODERATOR, isModerator: true, permissions: [], bannedAt: null },
      apiKeyId: 1,
      apiKeyType: 'User',
      subject: { type: 'apiKey', id: 1 },
      tokenScope,
    });
    const withKey = { headers: { authorization: 'Bearer key-under-test' } };

    it('control: a moderator’s full-access personal key is accepted', async () => {
      h.bearer.mockResolvedValue(keySession(TokenScope.Full));
      const { status } = await call(
        { workflowIds: ['wf-auth'], reason: REASON, execute: true },
        withKey
      );
      expect(status).toBe(200);
      expect(h.bearer).toHaveBeenCalledWith('key-under-test');
      expect(h.refundTransaction).toHaveBeenCalledTimes(1);
    });

    it('refuses a narrower-scoped key from the same moderator', async () => {
      h.bearer.mockResolvedValue(keySession(TokenScope.UserRead));
      const { status } = await call(
        { workflowIds: ['wf-auth'], reason: REASON, execute: true },
        withKey
      );
      expect(status).toBe(403);
      expectNoMoneyMoved();
    });

    it('refuses an unknown key', async () => {
      h.bearer.mockResolvedValue(null);
      const { status } = await call(
        { workflowIds: ['wf-auth'], reason: REASON, execute: true },
        withKey
      );
      expect(status).toBe(401);
      expectNoMoneyMoved();
    });
  });
});

// ─── Input validation ───────────────────────────────────────────────────────

describe('input validation', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `wf-bulk-${i}`);

  it.each([
    ['no workflowIds', { workflowIds: [] }],
    ['51 workflowIds', { workflowIds: ids(51) }],
    ['a duplicated workflowId', { workflowIds: ['wf-a', 'wf-b', 'wf-a'] }],
    ['an empty workflowId', { workflowIds: [''] }],
    ['a 9-char reason', { reason: 'x'.repeat(9) }],
    ['a 501-char reason', { reason: 'x'.repeat(501) }],
    ['a reason that is only whitespace', { reason: ' '.repeat(20) }],
    ['no reason', { reason: undefined }],
    ['feedbackId 0', { feedbackId: 0 }],
    ['a fractional feedbackId', { feedbackId: 1.5 }],
  ])('refuses %s with a 400 before planning', async (_label, patch) => {
    const { status } = await call({
      workflowIds: ['wf-a'],
      reason: REASON,
      execute: true,
      ...patch,
    });
    expect(status).toBe(400);
    expect(h.getAppWorkflowRecords).not.toHaveBeenCalled();
    expectNoMoneyMoved();
  });

  it.each([
    ['exactly 50 workflowIds', { workflowIds: ids(50) }],
    ['a 10-char reason', { reason: 'x'.repeat(10) }],
    ['a 500-char reason', { reason: 'x'.repeat(500) }],
  ])('control: accepts %s', async (_label, patch) => {
    const { status } = await call({ workflowIds: ['wf-a'], reason: REASON, ...patch });
    expect(status).toBe(200);
    expect(h.getAppWorkflowRecords).toHaveBeenCalledTimes(1);
  });
});

// ─── Dry run ────────────────────────────────────────────────────────────────

describe('dry run', () => {
  beforeEach(() =>
    addWorkflow({
      id: 'wf-dry',
      legs: [
        { n: 11, amount: 211, colour: 'yellow' },
        { n: 12, amount: 43, colour: 'blue' },
      ],
      fee: { state: 'unsettled', amount: 19, colour: 'yellow' },
    })
  );

  it.each([
    ['execute omitted', {}],
    ['execute=false', { execute: false }],
    ['execute="false" (a string, as a query param arrives)', { execute: 'false' }],
  ])('%s moves no money and reports what execute would do', async (_label, extra) => {
    const { status, body } = await call({ workflowIds: ['wf-dry'], reason: REASON, ...extra });
    expect(status).toBe(200);
    expect(body.execute).toBe(false);
    expect(body.workflows[0]).toMatchObject({
      outcome: 'would-refund',
      userId: VIEWER,
      app: { id: APP, name: APP_NAME },
      refundBuzz: 273,
      legs: [
        { transactionId: txId(11), amount: 211, buzzType: 'yellow', status: 'would-refund' },
        { transactionId: txId(12), amount: 43, buzzType: 'blue', status: 'would-refund' },
      ],
      authorFee: { state: 'unsettled', treatment: 'reversed', feeBuzz: 19, status: 'would-apply' },
    });
    expect(body.totals).toMatchObject({
      plannedBuzz: 273,
      plannedByColour: { yellow: 230, blue: 43 },
    });
    expectNoMoneyMoved();
    expect(h.createNotification).not.toHaveBeenCalled();
    // The accrual row is untouched, so the fee is still the author's to be paid if nobody executes.
    expect(world.fees).toHaveLength(1);
  });

  it('control: execute=true on the same workflow does move the money', async () => {
    const { body } = await refund(['wf-dry']);
    expect(body.workflows[0].outcome).toBe('refunded');
    expect(h.refundTransaction).toHaveBeenCalledTimes(2);
  });
});

// ─── Execute ────────────────────────────────────────────────────────────────

describe('execute', () => {
  it('refunds a single leg by its own transaction id (Buzz returns it to its payer, in its colour)', async () => {
    addWorkflow({ id: 'wf-one', legs: [{ n: 21, amount: 137, colour: 'green' }] });
    const { status, body } = await refund(['wf-one']);
    expect(status).toBe(200);
    expect(h.refundTransaction).toHaveBeenCalledWith(
      txId(21),
      'Refund: App generation not delivered',
      { workflowId: 'wf-one', moderatorRefund: true, moderatorId: MODERATOR }
    );
    expect(body.workflows[0]).toMatchObject({
      outcome: 'refunded',
      refundBuzz: 137,
      legs: [{ status: 'refunded', refundTransactionId: `refund-${txId(21)}` }],
      errors: [],
    });
    expect(body.totals).toMatchObject({ refundBuzz: 137, refunded: 1, failed: 0 });
  });

  it('refunds every leg of a multi-colour workflow, each in its own colour', async () => {
    addWorkflow({
      id: 'wf-multi',
      legs: [
        { n: 31, amount: 211, colour: 'yellow' },
        { n: 32, amount: 43, colour: 'blue' },
        { n: 33, amount: 67, colour: 'yellow' },
      ],
    });
    const { body } = await refund(['wf-multi']);
    expect(h.refundTransaction.mock.calls.map((c) => c[0]).sort()).toEqual(
      [txId(31), txId(32), txId(33)].sort()
    );
    expect(body.workflows[0].refundBuzz).toBe(321);
    expect(body.totals.plannedByColour).toEqual({ yellow: 278, blue: 43 });
  });

  it('a second identical call refunds nothing and reports already-refunded', async () => {
    addWorkflow({
      id: 'wf-twice',
      legs: [{ n: 41, amount: 89, colour: 'yellow' }],
      fee: { state: 'unsettled', amount: 13, colour: 'yellow' },
    });
    const first = await refund(['wf-twice']);
    expect(first.body.workflows[0]).toMatchObject({ outcome: 'refunded', refundBuzz: 102 });
    const legRefunds = h.refundTransaction.mock.calls.length;
    const feeRefunds = h.createBuzzTransactionMany.mock.calls.length;

    const second = await refund(['wf-twice']);
    expect(second.body.workflows[0]).toMatchObject({
      outcome: 'already-refunded',
      refundBuzz: 0,
      legs: [{ status: 'already-refunded', refundTransactionId: `refund-${txId(41)}` }],
      authorFee: { treatment: 'already-refunded' },
    });
    expect(h.refundTransaction.mock.calls.length).toBe(legRefunds);
    expect(h.createBuzzTransactionMany.mock.calls.length).toBe(feeRefunds);
    expect(h.createNotification).toHaveBeenCalledTimes(1);
  });

  it('a partly refunded workflow gets only its missing legs', async () => {
    addWorkflow({
      id: 'wf-partial',
      legs: [
        { n: 51, amount: 59, colour: 'yellow' },
        { n: 52, amount: 31, colour: 'blue' },
      ],
    });
    alreadyRefunded(51);
    const { body } = await refund(['wf-partial']);
    expect(h.refundTransaction).toHaveBeenCalledTimes(1);
    expect(h.refundTransaction).toHaveBeenCalledWith(
      txId(52),
      expect.any(String),
      expect.any(Object)
    );
    expect(body.workflows[0]).toMatchObject({
      outcome: 'refunded',
      refundBuzz: 31,
      legs: [
        { transactionId: txId(51), status: 'already-refunded' },
        { transactionId: txId(52), status: 'refunded' },
      ],
    });
  });

  it('an already fully refunded workflow moves nothing', async () => {
    addWorkflow({ id: 'wf-done', legs: [{ n: 61, amount: 71, colour: 'yellow' }] });
    alreadyRefunded(61);
    const { body } = await refund(['wf-done']);
    expect(body.workflows[0]).toMatchObject({ outcome: 'already-refunded', refundBuzz: 0 });
    expectNoMoneyMoved();
    expect(h.createNotification).not.toHaveBeenCalled();
  });

  it('a workflow the orchestrator credited back in full is already refunded', async () => {
    addWorkflow({
      id: 'wf-orch-full',
      legs: [{ n: 71, amount: 83, colour: 'yellow' }],
      credits: [{ amount: 83, colour: 'yellow' }],
    });
    const { body } = await refund(['wf-orch-full']);
    expect(body.workflows[0].outcome).toBe('already-refunded');
    expectNoMoneyMoved();
  });

  describe('skips, and never refunds', () => {
    it.each([
      ...(['failed', 'expired', 'canceled'] as string[]).map(
        (status) =>
          [
            `a workflow that ${status} — the orchestrator refunds those itself`,
            () =>
              addWorkflow({
                id: 'wf-x',
                status,
                legs: [{ n: 80, amount: 97, colour: 'yellow' }],
              }),
            'not-succeeded',
          ] as [string, () => void, string]
      ),
      [
        'a credit in a colour nothing was debited in',
        () =>
          addWorkflow({
            id: 'wf-x',
            legs: [{ n: 89, amount: 97, colour: 'yellow' }],
            credits: [{ amount: 11, colour: 'blue' }],
          }),
        'orchestrator-partial-refund',
      ],
      [
        'credits exceeding the debit in a colour',
        () =>
          addWorkflow({
            id: 'wf-x',
            legs: [{ n: 90, amount: 97, colour: 'yellow' }],
            credits: [{ amount: 98, colour: 'yellow' }],
          }),
        'orchestrator-partial-refund',
      ],
      [
        'a recorded paid spend the orchestrator read shows no debit for',
        () => {
          addWorkflow({ id: 'wf-x', legs: [{ n: 91, amount: 97, colour: 'yellow' }] });
          world.orchestrator.set('wf-x', { found: true, status: 'succeeded', transactions: [] });
        },
        'charges-unreadable',
      ],
      [
        'a charged fee with no generation debit — never the fee alone',
        () =>
          addWorkflow({ id: 'wf-x', fee: { state: 'unsettled', amount: 17, colour: 'yellow' } }),
        'charges-unreadable',
      ],
      [
        'a colour the orchestrator partly credited',
        () =>
          addWorkflow({
            id: 'wf-x',
            legs: [{ n: 81, amount: 97, colour: 'yellow' }],
            credits: [{ amount: 29, colour: 'yellow' }],
          }),
        'orchestrator-partial-refund',
      ],
      [
        'a workflow the orchestrator does not have',
        () => {
          addWorkflow({ id: 'wf-x', legs: [{ n: 82, amount: 97, colour: 'yellow' }] });
          world.orchestrator.set('wf-x', { found: false });
        },
        'workflow-not-found',
      ],
      [
        'records naming two different users',
        () => {
          addWorkflow({ id: 'wf-x', legs: [{ n: 83, amount: 97, colour: 'yellow' }] });
          world.spends[0].userId = OTHER_VIEWER;
        },
        'mixed-users',
      ],
      [
        'a fee charged to a different user than the records name',
        () => {
          addWorkflow({
            id: 'wf-x',
            legs: [{ n: 84, amount: 97, colour: 'yellow' }],
            fee: { state: 'unaccrued', amount: 17, colour: 'yellow' },
          });
          world.ledger.set(feeChargeKey('wf-x'), {
            ...world.ledger.get(feeChargeKey('wf-x'))!,
            fromAccountId: OTHER_VIEWER,
          });
        },
        'mixed-users',
      ],
      [
        'a workflow still processing',
        () =>
          addWorkflow({
            id: 'wf-x',
            status: 'processing',
            legs: [{ n: 85, amount: 97, colour: 'yellow' }],
          }),
        'not-terminal',
      ],
      [
        'a charge that is not a Buzz ledger transaction',
        () =>
          addWorkflow({
            id: 'wf-x',
            legs: [{ n: 86, amount: 97, colour: 'yellow' }],
            rawDebitIds: ['fund-17'],
          }),
        'unsupported-charge',
      ],
      ['a workflow that charged nothing', () => addWorkflow({ id: 'wf-x' }), 'no-charges'],
    ])('%s', async (_label, setup, reason) => {
      setup();
      const { status, body } = await refund(['wf-x']);
      expect(status).toBe(200);
      expect(body.workflows[0]).toMatchObject({ outcome: 'skipped', reason, refundBuzz: 0 });
      expectNoMoneyMoved();
    });

    it('a workflow id App Blocks never recorded — without asking the orchestrator', async () => {
      const { body } = await refund(['wf-elsewhere']);
      expect(body.workflows[0]).toMatchObject({ outcome: 'skipped', reason: 'not-app-blocks' });
      expect(h.getOrchestratorWorkflowCharges).not.toHaveBeenCalled();
      expectNoMoneyMoved();
    });

    it('a workflow whose charges could not be read', async () => {
      addWorkflow({ id: 'wf-x', legs: [{ n: 87, amount: 97, colour: 'yellow' }] });
      world.orchestrator.set('wf-x', new Error('orchestrator unavailable'));
      const { body } = await refund(['wf-x']);
      expect(body.workflows[0]).toMatchObject({
        outcome: 'skipped',
        reason: 'lookup-failed',
        detail: 'orchestrator unavailable',
      });
      expectNoMoneyMoved();
    });

    it('control: the same workflow, succeeded and fully charged, is refunded', async () => {
      addWorkflow({ id: 'wf-x', legs: [{ n: 88, amount: 97, colour: 'yellow' }] });
      const { body } = await refund(['wf-x']);
      expect(body.workflows[0].outcome).toBe('refunded');
    });
  });
});

// ─── Author fee ─────────────────────────────────────────────────────────────

describe('author fee', () => {
  const run = async (fee: FeeFixture) => {
    addWorkflow({ id: 'wf-fee', legs: [{ n: 91, amount: 101, colour: 'yellow' }], fee });
    return refund(['wf-fee']);
  };
  const feeRefunds = () =>
    h.createBuzzTransactionMany.mock.calls.flatMap((c) => c[0] as Record<string, unknown>[]);

  it('unsettled: reverses it — the accrual row goes, so the author is never paid it', async () => {
    const { body } = await run({ state: 'unsettled', amount: 23, colour: 'yellow' });
    expect(body.workflows[0]).toMatchObject({
      outcome: 'refunded',
      refundBuzz: 124,
      authorFee: { state: 'unsettled', treatment: 'reversed', status: 'done', feeBuzz: 23 },
    });
    expect(dbMock.dbWrite.blockAuthorFeeAccrual.deleteMany).toHaveBeenCalledTimes(1);
    expect(world.fees).toHaveLength(0);
    expect(feeRefunds()).toEqual([
      expect.objectContaining({
        fromAccountId: 0,
        toAccountId: VIEWER,
        amount: 23,
        externalTransactionId: feeReversalKey('wf-fee'),
      }),
    ]);
  });

  it.each([
    ['settled', 'settled' as const],
    ['still "accrued" but its accrual day has closed', 'settled-by-day' as const],
  ])(
    '%s: the user is refunded, the platform absorbs it, and the owner is NOT debited',
    async (_label, state) => {
      const { body } = await run({ state, amount: 29, colour: 'green' });
      expect(body.workflows[0]).toMatchObject({
        outcome: 'refunded',
        refundBuzz: 130,
        authorFee: { state: 'settled', treatment: 'platform-absorbed', status: 'done' },
      });
      // The author keeps the fee: the accrual row stands, nothing was claimed or reversed…
      expect(dbMock.dbWrite.blockAuthorFeeAccrual.deleteMany).not.toHaveBeenCalled();
      expect(world.fees).toHaveLength(1);
      // …and the only fee money that moved went from the platform to the user.
      expect(feeRefunds()).toEqual([
        expect.objectContaining({
          fromAccountId: 0,
          toAccountId: VIEWER,
          fromAccountType: 'green',
          amount: 29,
          externalTransactionId: feeReversalKey('wf-fee'),
        }),
      ]);
      const touched = [
        ...feeRefunds().flatMap((r) => [r.fromAccountId, r.toAccountId]),
        ...h.refundTransaction.mock.calls.map((c) => world.legPayer.get(c[0] as string)?.userId),
      ];
      expect(touched).not.toContain(OWNER);
    }
  );

  it('charged with no accrual: refunded under the reversal key', async () => {
    const { body } = await run({ state: 'unaccrued', amount: 37, colour: 'yellow' });
    expect(body.workflows[0].authorFee).toMatchObject({
      state: 'unaccrued',
      treatment: 'refunded',
    });
    expect(feeRefunds()).toEqual([
      expect.objectContaining({
        toAccountId: VIEWER,
        amount: 37,
        externalTransactionId: feeReversalKey('wf-fee'),
      }),
    ]);
  });

  it('already reversed: not returned a second time', async () => {
    const { body } = await run({ state: 'reversed', amount: 41, colour: 'yellow' });
    expect(body.workflows[0]).toMatchObject({
      refundBuzz: 101,
      authorFee: { state: 'reversed', treatment: 'already-refunded' },
    });
    expect(h.createBuzzTransactionMany).not.toHaveBeenCalled();
  });
});

describe('author fee: races and failures at execute time', () => {
  const feeRows = () =>
    h.createBuzzTransactionMany.mock.calls.flatMap((c) => c[0] as Record<string, unknown>[]);
  const LEG = { n: 171, amount: 211, colour: 'yellow' };
  const add = (fee: FeeFixture) => addWorkflow({ id: 'wf-race-fee', legs: [LEG], fee });
  const FB = 4507;
  const linkFeedback = () =>
    world.feedback.set(FB, { id: FB, area: 'app-block', userId: VIEWER, appBlockId: APP });

  it('an accrual day that closes between plan and execute falls back to platform-absorbed, counted once', async () => {
    add({ state: 'unsettled', amount: 31, colour: 'yellow' });
    // Planned as reversible; by execute the row's day has closed, so the reversal refuses it.
    betweenPlanAndExecute(() => {
      world.fees[0].accruedAt = YESTERDAY;
    });
    const { body } = await refund(['wf-race-fee']);
    expect(body.workflows[0]).toMatchObject({
      outcome: 'refunded',
      refundBuzz: 242,
      authorFee: { treatment: 'platform-absorbed', status: 'done' },
    });
    expect(dbMock.dbWrite.blockAuthorFeeAccrual.deleteMany).not.toHaveBeenCalled();
    expect(world.fees).toHaveLength(1);
    expect(feeRows()).toEqual([
      expect.objectContaining({
        toAccountId: VIEWER,
        amount: 31,
        externalTransactionId: feeReversalKey('wf-race-fee'),
      }),
    ]);
    expect(h.createNotification).toHaveBeenCalledTimes(1);
    expect(h.createNotification.mock.calls[0][0].details).toMatchObject({ amount: 242 });
  });

  it('the same after a settlement flip between plan and execute (status, not day)', async () => {
    add({ state: 'unsettled', amount: 37, colour: 'yellow' });
    betweenPlanAndExecute(() => {
      world.fees[0].status = 'settled';
    });
    const { body } = await refund(['wf-race-fee']);
    expect(body.workflows[0]).toMatchObject({
      refundBuzz: 248,
      authorFee: { treatment: 'platform-absorbed', status: 'done' },
    });
    expect(feeRows()).toHaveLength(1);
  });

  it('another reverser claims the row first, its refund on the ledger: already-refunded, not counted', async () => {
    add({ state: 'unsettled', amount: 41, colour: 'yellow' });
    dbMock.dbWrite.blockAuthorFeeAccrual.deleteMany.mockImplementationOnce(async () => {
      world.fees.splice(0, 1);
      world.ledger.set(feeReversalKey('wf-race-fee'), {
        fromAccountId: 0,
        toAccountId: VIEWER,
        fromAccountType: 'yellow',
        toAccountType: 'yellow',
        amount: 41,
      });
      return { count: 0 };
    });
    const { body } = await refund(['wf-race-fee']);
    expect(body.workflows[0]).toMatchObject({
      outcome: 'refunded',
      refundBuzz: 211,
      authorFee: { treatment: 'already-refunded', status: 'done' },
      errors: [],
    });
    expect(h.createBuzzTransactionMany).not.toHaveBeenCalled();
    expect(h.createNotification.mock.calls[0][0].details).toMatchObject({ amount: 211 });
  });

  it('another reverser claims the row first, its refund NOT yet on the ledger: failed, not counted', async () => {
    add({ state: 'unsettled', amount: 43, colour: 'yellow' });
    dbMock.dbWrite.blockAuthorFeeAccrual.deleteMany.mockImplementationOnce(async () => {
      world.fees.splice(0, 1);
      return { count: 0 };
    });
    const { body } = await refund(['wf-race-fee']);
    expect(body.workflows[0]).toMatchObject({
      outcome: 'failed',
      refundBuzz: 211,
      authorFee: { status: 'failed' },
    });
    expect(body.workflows[0].errors.join(' ')).toContain('in progress elsewhere');
    expect(h.createBuzzTransactionMany).not.toHaveBeenCalled();
  });

  it('a fee refund Buzz answers as a conflict (no pre-read hit) is already-refunded, not counted', async () => {
    add({ state: 'settled', amount: 47, colour: 'yellow' });
    h.createBuzzTransactionMany.mockResolvedValueOnce({
      transactions: [],
      conflicts: [feeReversalKey('wf-race-fee')],
    });
    const { body } = await refund(['wf-race-fee']);
    expect(body.workflows[0]).toMatchObject({
      outcome: 'refunded',
      refundBuzz: 211,
      byColour: { yellow: 211 },
      authorFee: { treatment: 'already-refunded', status: 'done' },
    });
    expect(h.createNotification.mock.calls[0][0].details).toMatchObject({ amount: 211 });
  });

  it('a reversal whose refund does not land: failed, not counted, feedback left open', async () => {
    linkFeedback();
    add({ state: 'unsettled', amount: 53, colour: 'yellow' });
    h.createBuzzTransactionMany.mockResolvedValueOnce({ transactions: [], conflicts: [] });
    const { body } = await refund(['wf-race-fee'], { feedbackId: FB });
    expect(body.workflows[0]).toMatchObject({
      outcome: 'failed',
      refundBuzz: 211,
      authorFee: { treatment: 'reversed', status: 'failed' },
    });
    expect(body.workflows[0].errors.join(' ')).toContain('did not land');
    expect(body.feedback).toMatchObject({ feedbackId: FB, resolved: false });
    expect(h.modResolveAppFeedbackWithRefund.mock.calls[0][0].resolve).toBe(false);
  });
});

// ─── Cap ────────────────────────────────────────────────────────────────────

describe('the 5,000 Buzz per-call cap', () => {
  it('exactly 5,000 is allowed without the large grant', async () => {
    addWorkflow({ id: 'wf-cap', legs: [{ n: 101, amount: 5000, colour: 'yellow' }] });
    const { status, body } = await refund(['wf-cap']);
    expect(status).toBe(200);
    expect(body.workflows[0].outcome).toBe('refunded');
    expect(h.hasModeratorGrant).not.toHaveBeenCalledWith(
      expect.anything(),
      'apps.buzz.refund.large'
    );
  });

  it.each([
    [
      'one 5,001 leg',
      () => addWorkflow({ id: 'wf-cap', legs: [{ n: 102, amount: 5001, colour: 'yellow' }] }),
    ],
    [
      'legs in two colours summing to 5,001',
      () =>
        addWorkflow({
          id: 'wf-cap',
          legs: [
            { n: 103, amount: 2600, colour: 'yellow' },
            { n: 104, amount: 2401, colour: 'blue' },
          ],
        }),
    ],
    [
      '4,990 of legs plus an 11 Buzz fee',
      () =>
        addWorkflow({
          id: 'wf-cap',
          legs: [{ n: 105, amount: 4990, colour: 'yellow' }],
          fee: { state: 'settled', amount: 11, colour: 'yellow' },
        }),
    ],
  ])('%s is refused without the large grant, before any money moves', async (_label, setup) => {
    setup();
    const { status, body } = await refund(['wf-cap']);
    expect(status).toBe(403);
    expect(body.message).toContain('apps.buzz.refund.large');
    expectNoMoneyMoved();
  });

  it('5,001 across two workflows is refused too — the cap is per call', async () => {
    addWorkflow({ id: 'wf-cap-a', legs: [{ n: 106, amount: 3001, colour: 'yellow' }] });
    addWorkflow({ id: 'wf-cap-b', legs: [{ n: 107, amount: 2000, colour: 'yellow' }] });
    const { status } = await refund(['wf-cap-a', 'wf-cap-b']);
    expect(status).toBe(403);
    expectNoMoneyMoved();
  });

  it('control: 5,001 is refunded for a holder of the large grant', async () => {
    holds('apps.buzz.refund', 'apps.buzz.refund.large');
    addWorkflow({ id: 'wf-cap', legs: [{ n: 108, amount: 5001, colour: 'yellow' }] });
    const { status, body } = await refund(['wf-cap']);
    expect(status).toBe(200);
    expect(body.workflows[0].outcome).toBe('refunded');
    expect(body.cap).toEqual({
      limitBuzz: 5000,
      plannedBuzz: 5001,
      exceeded: true,
      largeGrantHeld: true,
    });
  });

  it('a dry run over the cap reports it rather than refusing', async () => {
    addWorkflow({ id: 'wf-cap', legs: [{ n: 109, amount: 5001, colour: 'yellow' }] });
    const { status, body } = await dryRun(['wf-cap']);
    expect(status).toBe(200);
    expect(body.cap).toEqual({
      limitBuzz: 5000,
      plannedBuzz: 5001,
      exceeded: true,
      largeGrantHeld: false,
    });
    expectNoMoneyMoved();
  });

  it('already-refunded legs do not count toward the cap', async () => {
    addWorkflow({
      id: 'wf-cap',
      legs: [
        { n: 110, amount: 4000, colour: 'yellow' },
        { n: 111, amount: 1999, colour: 'yellow' },
      ],
    });
    alreadyRefunded(110);
    const { status, body } = await refund(['wf-cap']);
    expect(status).toBe(200);
    expect(body.totals.refundBuzz).toBe(1999);
  });
});

// ─── Partial failure ────────────────────────────────────────────────────────

describe('partial failure', () => {
  it('a leg that throws fails its workflow; the others proceed; nothing false is reported', async () => {
    addWorkflow({
      id: 'wf-bad',
      legs: [
        { n: 121, amount: 53, colour: 'yellow' },
        { n: 122, amount: 47, colour: 'blue' },
      ],
    });
    addWorkflow({ id: 'wf-good', legs: [{ n: 123, amount: 61, colour: 'yellow' }] });
    world.failRefund.add(txId(122));

    const { status, body } = await refund(['wf-bad', 'wf-good']);
    expect(status).toBe(200);
    const [bad, good] = body.workflows;
    expect(bad).toMatchObject({
      outcome: 'failed',
      refundBuzz: 53,
      legs: [
        { transactionId: txId(121), status: 'refunded' },
        { transactionId: txId(122), status: 'failed', refundTransactionId: null },
      ],
    });
    expect(bad.errors.join(' ')).toContain('Buzz service unavailable');
    expect(good).toMatchObject({ outcome: 'refunded', refundBuzz: 61 });
    expect(body.totals).toMatchObject({ refundBuzz: 114, refunded: 1, failed: 1 });
    // The user is told about the money that DID come back, once.
    expect(h.createNotification).toHaveBeenCalledTimes(1);
    expect(h.createNotification.mock.calls[0][0].details).toMatchObject({ amount: 114 });
  });

  it('a fee refund that does not land fails the workflow', async () => {
    addWorkflow({
      id: 'wf-fee-drop',
      legs: [{ n: 124, amount: 73, colour: 'yellow' }],
      fee: { state: 'settled', amount: 7, colour: 'yellow' },
    });
    h.createBuzzTransactionMany.mockResolvedValue({ transactions: [], conflicts: [] });
    const { body } = await refund(['wf-fee-drop']);
    expect(body.workflows[0]).toMatchObject({
      outcome: 'failed',
      refundBuzz: 73,
      authorFee: { status: 'failed', treatment: 'platform-absorbed' },
    });
  });

  it('a leg answering 409 with its refund on the ledger is neither a failure nor counted', async () => {
    addWorkflow({ id: 'wf-race', legs: [{ n: 125, amount: 79, colour: 'yellow' }] });
    // Another call refunded the leg between this call's ledger re-read and its refund.
    h.refundTransaction.mockImplementationOnce(async () => {
      alreadyRefunded(125);
      throw conflict();
    });
    const { body } = await refund(['wf-race']);
    expect(body.workflows[0]).toMatchObject({
      outcome: 'already-refunded',
      refundBuzz: 0,
      legs: [{ status: 'already-refunded' }],
      errors: [],
    });
    expect(h.createNotification).not.toHaveBeenCalled();
  });

  describe('only what THIS call created is counted (Buzz answers a repeat refund 200)', () => {
    beforeEach(() => {
      world.repeat200 = true;
    });
    it('a leg refunded by another call since the plan is reported, not counted or notified', async () => {
      addWorkflow({ id: 'wf-200', legs: [{ n: 161, amount: 167, colour: 'yellow' }] });
      betweenPlanAndExecute(() => alreadyRefunded(161));
      const { body } = await refund(['wf-200']);
      expect(body.workflows[0]).toMatchObject({
        outcome: 'already-refunded',
        refundBuzz: 0,
        legs: [{ status: 'already-refunded', refundTransactionId: `refund-${txId(161)}` }],
      });
      expect(body.totals.refundBuzz).toBe(0);
      expect(h.refundTransaction).not.toHaveBeenCalled();
      expect(h.createNotification).not.toHaveBeenCalled();
    });

    it('a fee returned by another call since the plan is reported, not counted', async () => {
      addWorkflow({
        id: 'wf-200-fee',
        legs: [{ n: 162, amount: 173, colour: 'yellow' }],
        fee: { state: 'settled', amount: 13, colour: 'yellow' },
      });
      betweenPlanAndExecute(() =>
        world.ledger.set(feeReversalKey('wf-200-fee'), {
          fromAccountId: 0,
          toAccountId: VIEWER,
          fromAccountType: 'yellow',
          toAccountType: 'yellow',
          amount: 13,
        })
      );
      const { body } = await refund(['wf-200-fee']);
      expect(body.workflows[0]).toMatchObject({
        outcome: 'refunded',
        refundBuzz: 173,
        byColour: { yellow: 173 },
        authorFee: { treatment: 'already-refunded', status: 'done' },
      });
      expect(h.createBuzzTransactionMany).not.toHaveBeenCalled();
      expect(h.createNotification.mock.calls[0][0].details).toMatchObject({ amount: 173 });
    });
  });

  it('a re-run after a partly failed call refunds only what is still missing', async () => {
    addWorkflow({
      id: 'wf-retry',
      legs: [
        { n: 126, amount: 83, colour: 'yellow' },
        { n: 127, amount: 29, colour: 'blue' },
      ],
    });
    world.failRefund.add(txId(127));
    const first = await refund(['wf-retry']);
    expect(first.body.workflows[0]).toMatchObject({ outcome: 'failed', refundBuzz: 83 });

    world.failRefund.clear();
    const second = await refund(['wf-retry']);
    expect(second.body.workflows[0]).toMatchObject({
      outcome: 'refunded',
      refundBuzz: 29,
      legs: [
        { transactionId: txId(126), status: 'already-refunded' },
        { transactionId: txId(127), status: 'refunded' },
      ],
    });
    const third = await refund(['wf-retry']);
    expect(third.body.workflows[0]).toMatchObject({ outcome: 'already-refunded', refundBuzz: 0 });
    expect(h.refundTransaction.mock.calls.map((c) => c[0])).toEqual([
      txId(126),
      txId(127),
      txId(127),
    ]);
  });

  it('a refund touches only money: no raw SQL write, no accrual claim for a settled fee', async () => {
    addWorkflow({
      id: 'wf-money-only',
      legs: [{ n: 128, amount: 31, colour: 'yellow' }],
      fee: { state: 'settled', amount: 5, colour: 'yellow' },
    });
    const { body } = await refund(['wf-money-only']);
    expect(body.workflows[0].outcome).toBe('refunded');
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.blockAuthorFeeAccrual.deleteMany).not.toHaveBeenCalled();
  });
});

// ─── Overlapping executes ───────────────────────────────────────────────────

describe('two overlapping executes of one workflow (Buzz answers the repeat refund 200)', () => {
  const FB = 4519;
  /** The execute lock runs for real, on an in-memory Redis: `SET NX` refuses a held key. */
  let locks: Map<string, string>;
  beforeEach(() => {
    world.repeat200 = true;
    world.feedback.set(FB, { id: FB, area: 'app-block', userId: VIEWER, appBlockId: APP });
    locks = new Map();
    redisMock.redis.set.mockImplementation(
      async (key: string, value: string, opts?: { NX?: boolean }) => {
        if (opts?.NX && locks.has(key)) return null;
        locks.set(key, value);
        return 'OK';
      }
    );
    redisMock.redis.eval.mockImplementation(
      async (
        script: string,
        { keys, arguments: args }: { keys: string[]; arguments: string[] }
      ) => {
        if (/pexpire/i.test(script)) return 1;
        if (locks.get(keys[0]) !== args[0]) return 0;
        locks.delete(keys[0]);
        return 1;
      }
    );
  });
  afterEach(() => {
    // Every other test in this file runs on the canonical defaults: any SET answers OK.
    redisMock.redis.set.mockImplementation(async () => 'OK');
    redisMock.redis.eval.mockReset();
  });

  /** Each Buzz refund takes `ms`, so a second call starts while the first is still mid-refund. */
  const slowBuzz = (ms: number) => {
    const real = h.refundTransaction.getMockImplementation()!;
    h.refundTransaction.mockImplementation(async (...a) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return real(...a);
    });
  };

  it('only one call counts, notes and notifies the legs; the other reports them already-refunded', async () => {
    addWorkflow({
      id: 'wf-overlap',
      legs: [
        { n: 181, amount: 241, colour: 'yellow' },
        { n: 182, amount: 251, colour: 'blue' },
      ],
    });
    slowBuzz(300);
    const calls = await Promise.all([
      refund(['wf-overlap'], { feedbackId: FB }),
      refund(['wf-overlap'], { feedbackId: FB }),
    ]);
    const rows = calls.map((c) => c.body.workflows[0]);
    expect(rows.map((r) => r.outcome).sort()).toEqual(['already-refunded', 'refunded']);
    const winner = rows.find((r) => r.outcome === 'refunded');
    const loser = rows.find((r) => r.outcome === 'already-refunded');
    expect(winner).toMatchObject({
      refundBuzz: 492,
      byColour: { yellow: 241, blue: 251 },
      legs: [{ status: 'refunded' }, { status: 'refunded' }],
    });
    expect(loser).toMatchObject({
      refundBuzz: 0,
      byColour: {},
      legs: [
        { status: 'already-refunded', refundTransactionId: `refund-${txId(181)}` },
        { status: 'already-refunded', refundTransactionId: `refund-${txId(182)}` },
      ],
    });
    expect(calls.map((c) => c.body.totals.refundBuzz).sort((x, y) => x - y)).toEqual([0, 492]);
    // Each leg reached Buzz once: the second call read the first one's refunds inside the lock.
    expect(h.refundTransaction).toHaveBeenCalledTimes(2);
    expect(h.createNotification).toHaveBeenCalledTimes(1);
    expect(h.createNotification.mock.calls[0][0].details).toMatchObject({ amount: 492 });
    const notes = h.modResolveAppFeedbackWithRefund.mock.calls.map((c) => c[0].note as string);
    expect(notes.filter((n) => n.startsWith('[App Buzz refund] 492 Buzz'))).toHaveLength(1);
    expect(notes.filter((n) => n.startsWith('[App Buzz refund] 0 Buzz'))).toHaveLength(1);
    expect(locks.size).toBe(0);
  });

  it('a lock still held when the wait runs out: failed, nothing refunded, counted or notified', async () => {
    addWorkflow({ id: 'wf-held', legs: [{ n: 183, amount: 263, colour: 'yellow' }] });
    // Another execute of this workflow holds the lock for longer than a caller waits (~5s).
    redisMock.redis.set.mockImplementation(async (key: string) =>
      key.endsWith(':app-workflow-refund:wf-held') ? null : 'OK'
    );
    const { body } = await refund(['wf-held'], { feedbackId: FB });
    expect(body.workflows[0]).toMatchObject({
      outcome: 'failed',
      refundBuzz: 0,
      byColour: {},
      legs: [{ transactionId: txId(183), status: 'failed', refundTransactionId: null }],
      errors: [expect.stringContaining('in progress')],
    });
    expect(body.totals).toMatchObject({ refundBuzz: 0, refunded: 0, failed: 1 });
    expectNoMoneyMoved();
    expect(h.createNotification).not.toHaveBeenCalled();
    expect(body.feedback).toMatchObject({ feedbackId: FB, resolved: false });
    expect(redisMock.redis.set.mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining([expect.stringMatching(/:app-workflow-refund:wf-held$/)])
    );
  });

  it('Redis failing on acquire: failed and nothing refunded — never refunded without the lock', async () => {
    addWorkflow({
      id: 'wf-no-redis',
      legs: [{ n: 184, amount: 271, colour: 'yellow' }],
      fee: { state: 'settled', amount: 17, colour: 'yellow' },
    });
    redisMock.redis.set.mockRejectedValue(new Error('redis unavailable'));
    const { body } = await refund(['wf-no-redis']);
    expect(body.workflows[0]).toMatchObject({
      outcome: 'failed',
      refundBuzz: 0,
      legs: [{ status: 'failed' }],
      authorFee: { status: 'failed' },
    });
    expectNoMoneyMoved();
    expect(h.createNotification).not.toHaveBeenCalled();
  });
});

// ─── Notifications ──────────────────────────────────────────────────────────

describe('notifying the refunded user', () => {
  it('once per user per call, with the total and the app, never the moderator’s reason', async () => {
    addWorkflow({ id: 'wf-n1', legs: [{ n: 131, amount: 113, colour: 'yellow' }] });
    addWorkflow({ id: 'wf-n2', legs: [{ n: 132, amount: 127, colour: 'blue' }] });
    await refund(['wf-n1', 'wf-n2']);
    expect(h.createNotification).toHaveBeenCalledTimes(1);
    const sent = h.createNotification.mock.calls[0][0];
    expect(sent).toMatchObject({
      userId: VIEWER,
      type: 'app-buzz-refund',
      category: 'Buzz',
      details: { amount: 240, appName: APP_NAME, appCount: 1 },
    });
    expect(JSON.stringify(h.createNotification.mock.calls)).not.toContain(REASON);
  });

  it('two users in one call are each notified once', async () => {
    addWorkflow({ id: 'wf-u1', legs: [{ n: 133, amount: 131, colour: 'yellow' }] });
    addWorkflow({
      id: 'wf-u2',
      userId: OTHER_VIEWER,
      appBlockId: OTHER_APP,
      legs: [{ n: 134, amount: 139, colour: 'yellow' }],
    });
    const { body } = await refund(['wf-u1', 'wf-u2']);
    expect(h.createNotification).toHaveBeenCalledTimes(2);
    const byUser = Object.fromEntries(
      h.createNotification.mock.calls.map((c) => [
        c[0].userId as number,
        (c[0].details as { amount: number }).amount,
      ])
    );
    expect(byUser).toEqual({ [VIEWER]: 131, [OTHER_VIEWER]: 139 });
    expect(body.notifiedUserIds.sort()).toEqual([VIEWER, OTHER_VIEWER].sort());
  });

  it('nobody is notified when nothing was refunded', async () => {
    addWorkflow({ id: 'wf-n0', legs: [{ n: 135, amount: 149, colour: 'yellow' }] });
    alreadyRefunded(135);
    await refund(['wf-n0']);
    expect(h.createNotification).not.toHaveBeenCalled();
  });
});

// ─── Feedback ───────────────────────────────────────────────────────────────

describe('linking feedback', () => {
  const FEEDBACK = 4481;
  beforeEach(() => addWorkflow({ id: 'wf-fb', legs: [{ n: 141, amount: 151, colour: 'yellow' }] }));

  it.each([
    ['filed by a different user', { userId: OTHER_VIEWER }, 400],
    ['not App feedback', { area: 'site' }, 400],
    ['about a different app', { appBlockId: OTHER_APP }, 400],
  ])('refuses feedback %s, before any money moves', async (_label, patch, code) => {
    world.feedback.set(FEEDBACK, {
      id: FEEDBACK,
      area: 'app-block',
      userId: VIEWER,
      appBlockId: APP,
      ...patch,
    });
    const { status } = await refund(['wf-fb'], { feedbackId: FEEDBACK });
    expect(status).toBe(code);
    expectNoMoneyMoved();
    expect(h.modResolveAppFeedbackWithRefund).not.toHaveBeenCalled();
  });

  it('refuses feedback that does not exist', async () => {
    const { status } = await refund(['wf-fb'], { feedbackId: FEEDBACK });
    expect(status).toBe(404);
    expectNoMoneyMoved();
  });

  it('refuses a mismatch on a dry run too', async () => {
    world.feedback.set(FEEDBACK, {
      id: FEEDBACK,
      area: 'app-block',
      userId: OTHER_VIEWER,
      appBlockId: APP,
    });
    const { status } = await dryRun(['wf-fb'], { feedbackId: FEEDBACK });
    expect(status).toBe(400);
  });

  it('resolves matching feedback with the refund recorded on it', async () => {
    world.feedback.set(FEEDBACK, {
      id: FEEDBACK,
      area: 'app-block',
      userId: VIEWER,
      appBlockId: APP,
    });
    const { status, body } = await refund(['wf-fb'], { feedbackId: FEEDBACK });
    expect(status).toBe(200);
    expect(body.feedback).toEqual({ feedbackId: FEEDBACK, resolved: true });
    expect(h.modResolveAppFeedbackWithRefund).toHaveBeenCalledTimes(1);
    const args = h.modResolveAppFeedbackWithRefund.mock.calls[0][0];
    expect(args).toMatchObject({
      moderatorId: MODERATOR,
      feedbackId: FEEDBACK,
      reporterUserId: VIEWER,
      resolve: true,
    });
    expect(args.note).toContain('151 Buzz');
    expect(args.note).toContain(`refund-${txId(141)}`);
    expect(args.note).toContain(REASON);
  });

  it('control: feedback with no app on it still matches by user', async () => {
    world.feedback.set(FEEDBACK, {
      id: FEEDBACK,
      area: 'app-block',
      userId: VIEWER,
      appBlockId: null,
    });
    const { status, body } = await refund(['wf-fb'], { feedbackId: FEEDBACK });
    expect(status).toBe(200);
    expect(body.feedback.resolved).toBe(true);
  });

  it('a dry run does not resolve it', async () => {
    world.feedback.set(FEEDBACK, {
      id: FEEDBACK,
      area: 'app-block',
      userId: VIEWER,
      appBlockId: APP,
    });
    await dryRun(['wf-fb'], { feedbackId: FEEDBACK });
    expect(h.modResolveAppFeedbackWithRefund).not.toHaveBeenCalled();
  });

  it('a call with a failed refund leaves it open', async () => {
    world.feedback.set(FEEDBACK, {
      id: FEEDBACK,
      area: 'app-block',
      userId: VIEWER,
      appBlockId: APP,
    });
    world.failRefund.add(txId(141));
    const { body } = await refund(['wf-fb'], { feedbackId: FEEDBACK });
    expect(body.feedback).toMatchObject({ feedbackId: FEEDBACK, resolved: false });
    expect(h.modResolveAppFeedbackWithRefund).toHaveBeenCalledWith(
      expect.objectContaining({ resolve: false, note: expect.stringContaining('wf-fb') })
    );
    expect(h.modResolveAppFeedbackWithRefund.mock.calls[0][0].note).toContain(
      'Buzz service unavailable'
    );
  });

  it('a call where any requested workflow was skipped leaves its status, and notes why', async () => {
    world.feedback.set(FEEDBACK, {
      id: FEEDBACK,
      area: 'app-block',
      userId: VIEWER,
      appBlockId: APP,
    });
    addWorkflow({
      id: 'wf-fb-failed',
      status: 'failed',
      legs: [{ n: 142, amount: 163, colour: 'yellow' }],
    });
    const { body } = await refund(['wf-fb', 'wf-fb-failed'], { feedbackId: FEEDBACK });
    expect(body.workflows.map((w: { outcome: string }) => w.outcome)).toEqual([
      'refunded',
      'skipped',
    ]);
    expect(body.feedback).toMatchObject({ feedbackId: FEEDBACK, resolved: false });
    const args = h.modResolveAppFeedbackWithRefund.mock.calls[0][0];
    expect(args.resolve).toBe(false);
    expect(args.note).toContain('wf-fb-failed (not-succeeded)');
  });

  it('control: every requested workflow already refunded still resolves it', async () => {
    world.feedback.set(FEEDBACK, {
      id: FEEDBACK,
      area: 'app-block',
      userId: VIEWER,
      appBlockId: APP,
    });
    alreadyRefunded(141);
    const { body } = await refund(['wf-fb'], { feedbackId: FEEDBACK });
    expect(body.feedback).toEqual({ feedbackId: FEEDBACK, resolved: true });
    expect(h.modResolveAppFeedbackWithRefund.mock.calls[0][0].resolve).toBe(true);
  });

  it('a feedback write that throws after the money moved is reported, not turned into an error', async () => {
    world.feedback.set(FEEDBACK, {
      id: FEEDBACK,
      area: 'app-block',
      userId: VIEWER,
      appBlockId: APP,
    });
    h.modResolveAppFeedbackWithRefund.mockRejectedValue(new Error('feedback table locked'));
    const { status, body } = await refund(['wf-fb'], { feedbackId: FEEDBACK });
    expect(status).toBe(200);
    expect(body.workflows[0]).toMatchObject({ outcome: 'refunded', refundBuzz: 151 });
    expect(body.feedback).toEqual({
      feedbackId: FEEDBACK,
      resolved: false,
      reason: 'feedback table locked',
    });
  });
});

// ─── Audit ──────────────────────────────────────────────────────────────────

describe('the audit row', () => {
  it('records the workflows, the users, the feedback and the free-text reason', async () => {
    const FEEDBACK = 4493;
    addWorkflow({ id: 'wf-audit', legs: [{ n: 151, amount: 157, colour: 'yellow' }] });
    world.feedback.set(FEEDBACK, {
      id: FEEDBACK,
      area: 'app-block',
      userId: VIEWER,
      appBlockId: APP,
    });
    await refund(['wf-audit'], { feedbackId: FEEDBACK });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'apps.refundWorkflows',
        outcome: 'ok',
        payload: expect.objectContaining({ reason: REASON, workflowIds: ['wf-audit'] }),
        affected: {
          workflowIds: ['wf-audit'],
          userIds: [VIEWER],
          feedbackIds: [FEEDBACK],
          execute: true,
          workflows: [
            {
              workflowId: 'wf-audit',
              userId: VIEWER,
              outcome: 'refunded',
              refundBuzz: 157,
              byColour: { yellow: 157 },
              refundTransactionIds: [`refund-${txId(151)}`],
            },
          ],
        },
      })
    );
  });

  it('records each workflow’s outcome, colours and refund ids — the fee included — and why one was skipped', async () => {
    addWorkflow({
      id: 'wf-audit-fee',
      legs: [
        { n: 152, amount: 179, colour: 'yellow' },
        { n: 153, amount: 181, colour: 'blue' },
      ],
      fee: { state: 'settled', amount: 19, colour: 'yellow' },
    });
    addWorkflow({
      id: 'wf-audit-skip',
      status: 'canceled',
      legs: [{ n: 154, amount: 191, colour: 'yellow' }],
    });
    await refund(['wf-audit-fee', 'wf-audit-skip']);
    const affected = h.audit.mock.calls[0][0].affected;
    expect(affected.workflows).toEqual([
      {
        workflowId: 'wf-audit-fee',
        userId: VIEWER,
        outcome: 'refunded',
        refundBuzz: 379,
        byColour: { yellow: 198, blue: 181 },
        refundTransactionIds: [
          `refund-${txId(152)}`,
          `refund-${txId(153)}`,
          feeReversalKey('wf-audit-fee'),
        ],
      },
      {
        workflowId: 'wf-audit-skip',
        userId: VIEWER,
        outcome: 'skipped',
        reason: 'not-succeeded',
        refundBuzz: 0,
        byColour: {},
        refundTransactionIds: [],
      },
    ]);
  });

  it('every refund carries the acting moderator — legs and the fee, through both fee paths', async () => {
    addWorkflow({
      id: 'wf-actor-a',
      legs: [{ n: 155, amount: 193, colour: 'yellow' }],
      fee: { state: 'unsettled', amount: 23, colour: 'yellow' },
    });
    addWorkflow({
      id: 'wf-actor-b',
      legs: [{ n: 156, amount: 197, colour: 'yellow' }],
      fee: { state: 'settled', amount: 29, colour: 'yellow' },
    });
    await refund(['wf-actor-a', 'wf-actor-b']);
    for (const c of h.refundTransaction.mock.calls)
      expect(c[2]).toMatchObject({ moderatorRefund: true, moderatorId: MODERATOR });
    const feeRows = h.createBuzzTransactionMany.mock.calls.flatMap(
      (c) => c[0] as Record<string, unknown>[]
    );
    expect(feeRows).toHaveLength(2);
    for (const row of feeRows)
      expect(row.details).toEqual({
        workflowId: expect.any(String),
        moderatorRefund: true,
        moderatorId: MODERATOR,
      });
  });
});
