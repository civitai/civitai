import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { redisMock } from '~/__tests__/mocks/redis.mock';

/**
 * `/api/mod/apps/workflow-charges`: the read-only lookup a moderator runs before a refund — one
 * account's App Blocks generations, their Buzz legs, the author fee and what is already refunded.
 *
 * The service runs for real; the platform tables, the orchestrator read and the Buzz ledger are
 * fixtures at their module boundaries (no SQL runs here — see `refund-workflows.test.ts`).
 */

const h = vi.hoisted(() => ({
  session: { user: {} as Record<string, unknown> },
  audit: vi.fn(),
  hasModeratorGrant: vi.fn<(...a: unknown[]) => Promise<boolean>>(async () => true),
  getTransactionByExternalId: vi.fn<(id: string) => Promise<unknown>>(),
  listAppWorkflowIdsForUser: vi.fn<(a: Record<string, unknown>) => Promise<string[]>>(),
  resolveListingAppBlockId: vi.fn<(l: string) => Promise<string | null>>(),
  getAppWorkflowRecords: vi.fn<(ids: string[]) => Promise<unknown>>(),
  getOrchestratorWorkflowCharges: vi.fn<(id: string) => Promise<unknown>>(),
  getAppNames: vi.fn<(ids: string[]) => Promise<Map<string, string>>>(),
}));

vi.mock('~/server/auth/bearer-token', () => ({
  getSessionFromBearerToken: vi.fn(async () => null),
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
  refundTransaction: vi.fn(),
  createBuzzTransactionMany: vi.fn(),
  getMultiAccountTransactionsByPrefix: vi.fn(),
  refundMultiAccountTransaction: vi.fn(),
}));
vi.mock('~/server/services/blocks/app-workflow-refund.data', () => ({
  listAppWorkflowIdsForUser: (a: Record<string, unknown>) => h.listAppWorkflowIdsForUser(a),
  resolveListingAppBlockId: (l: string) => h.resolveListingAppBlockId(l),
  getAppWorkflowRecords: (ids: string[]) => h.getAppWorkflowRecords(ids),
  getOrchestratorWorkflowCharges: (id: string) => h.getOrchestratorWorkflowCharges(id),
  getAppNames: (ids: string[]) => h.getAppNames(ids),
}));
vi.mock('~/server/services/blocks/app-feedback.service', () => ({
  getAppFeedbackForRefund: vi.fn(),
  modResolveAppFeedbackWithRefund: vi.fn(),
}));
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

import handler from '~/pages/api/mod/apps/workflow-charges';
import {
  planAppWorkflowRefunds,
  SKIP_REASONS,
  type SkipReason,
} from '~/server/services/blocks/app-workflow-refund.service';

const NOW = new Date('2026-11-07T12:00:00.000Z');
const TODAY = new Date('2026-11-07T08:15:00.000Z');
const YESTERDAY = new Date('2026-11-06T19:05:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

const MODERATOR = 990000007;
const VIEWER = 70411;
const OWNER = 70637;
const APP = 'apb_lookup_alpha';
const APP_NAME = 'Sample Lookup App';
const txId = (n: number) => `7c2d4e5f-0000-4000-8000-${String(n).padStart(12, '0')}`;

let ledger: Map<string, Record<string, unknown>>;

function call(body: Record<string, unknown>) {
  const req = { method: 'POST', headers: {}, body, query: {} } as unknown as Parameters<
    typeof handler
  >[0];
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

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.clearAllMocks();
  ledger = new Map();
  h.session.user = { id: MODERATOR, isModerator: true, permissions: [], bannedAt: null };
  h.hasModeratorGrant.mockImplementation(async (_a, id) => id === 'apps.buzz.refund');
  h.listAppWorkflowIdsForUser.mockResolvedValue([]);
  h.getAppWorkflowRecords.mockResolvedValue({ workflows: [], spends: [], fees: [] });
  h.getOrchestratorWorkflowCharges.mockResolvedValue({ found: false });
  h.getAppNames.mockImplementation(
    async (ids) => new Map(ids.map((id): [string, string] => [id, APP_NAME]))
  );
  h.getTransactionByExternalId.mockImplementation(async (id) => ledger.get(id) ?? null);
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  redisMock.sysRedis.ttl.mockResolvedValue(60);
});

describe('who may call it', () => {
  it('refuses a non-moderator', async () => {
    h.session.user = { id: VIEWER, isModerator: false, permissions: [], bannedAt: null };
    const { status } = await call({ userId: VIEWER });
    expect(status).toBe(403);
    expect(h.listAppWorkflowIdsForUser).not.toHaveBeenCalled();
  });

  it('refuses a moderator without apps.buzz.refund — the lookup lists a user’s spend', async () => {
    h.hasModeratorGrant.mockResolvedValue(false);
    const { status, body } = await call({ userId: VIEWER });
    expect(status).toBe(403);
    expect(body.message).toContain('apps.buzz.refund');
    expect(h.listAppWorkflowIdsForUser).not.toHaveBeenCalled();
  });

  it('control: a holder gets the list', async () => {
    const { status, body } = await call({ userId: VIEWER });
    expect(status).toBe(200);
    expect(body).toMatchObject({ userId: VIEWER, workflows: [] });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'apps.workflowCharges', affected: { userIds: [VIEWER] } })
    );
  });
});

describe('the date window', () => {
  const listed = () => h.listAppWorkflowIdsForUser.mock.calls[0][0];

  it('defaults to the last 30 days, ending now', async () => {
    await call({ userId: VIEWER });
    expect(listed()).toMatchObject({
      userId: VIEWER,
      from: new Date(NOW.getTime() - 30 * DAY),
      to: NOW,
      limit: 20,
    });
  });

  it('defaults `from` to 30 days before a given `to`', async () => {
    const to = new Date('2026-10-01T00:00:00.000Z');
    await call({ userId: VIEWER, to: to.toISOString() });
    expect(listed()).toMatchObject({ from: new Date(to.getTime() - 30 * DAY), to });
  });

  it('accepts exactly 90 days', async () => {
    const from = new Date(NOW.getTime() - 90 * DAY);
    const { status } = await call({ userId: VIEWER, from: from.toISOString() });
    expect(status).toBe(200);
    expect(listed()).toMatchObject({ from, to: NOW });
  });

  it.each([
    ['90 days and a millisecond', { from: new Date(NOW.getTime() - 90 * DAY - 1).toISOString() }],
    ['`from` equal to `to`', { from: NOW.toISOString(), to: NOW.toISOString() }],
    ['`from` after `to`', { from: '2026-11-02T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' }],
    ['an unparseable date', { from: 'not-a-date' }],
  ])('refuses %s with a 400', async (_label, patch) => {
    const { status } = await call({ userId: VIEWER, ...patch });
    expect(status).toBe(400);
    expect(h.listAppWorkflowIdsForUser).not.toHaveBeenCalled();
  });

  it.each([
    ['limit 0', { limit: 0 }],
    ['limit 51', { limit: 51 }],
    ['no userId', { userId: undefined }],
    ['appBlockId and listing together', { appBlockId: APP, listing: 'some-app' }],
  ])('refuses %s with a 400', async (_label, patch) => {
    const { status } = await call({ userId: VIEWER, ...patch });
    expect(status).toBe(400);
    expect(h.listAppWorkflowIdsForUser).not.toHaveBeenCalled();
  });

  it('control: limit 50 passes through', async () => {
    await call({ userId: VIEWER, limit: 50 });
    expect(listed()).toMatchObject({ limit: 50 });
  });
});

describe('filtering by app', () => {
  it('a listing id or slug resolves to the block it hosts', async () => {
    h.resolveListingAppBlockId.mockResolvedValue(APP);
    await call({ userId: VIEWER, listing: 'sample-lookup-app' });
    expect(h.resolveListingAppBlockId).toHaveBeenCalledWith('sample-lookup-app');
    expect(h.listAppWorkflowIdsForUser.mock.calls[0][0]).toMatchObject({ appBlockId: APP });
  });

  it('an unknown listing is a 404', async () => {
    h.resolveListingAppBlockId.mockResolvedValue(null);
    const { status } = await call({ userId: VIEWER, listing: 'no-such-app' });
    expect(status).toBe(404);
    expect(h.listAppWorkflowIdsForUser).not.toHaveBeenCalled();
  });

  it('an appBlockId passes straight through', async () => {
    await call({ userId: VIEWER, appBlockId: APP });
    expect(h.listAppWorkflowIdsForUser.mock.calls[0][0]).toMatchObject({ appBlockId: APP });
    expect(h.resolveListingAppBlockId).not.toHaveBeenCalled();
  });
});

describe('what each workflow reports', () => {
  const record = (workflowId: string, status = 'succeeded') => ({
    workflowId,
    userId: VIEWER,
    appBlockId: APP,
    status,
    submittedAt: TODAY,
  });

  beforeEach(() => {
    h.listAppWorkflowIdsForUser.mockResolvedValue(['wf-partial', 'wf-full', 'wf-running']);
    h.getAppWorkflowRecords.mockResolvedValue({
      workflows: [record('wf-partial'), record('wf-full'), record('wf-running', 'processing')],
      spends: [],
      fees: [
        {
          workflowId: 'wf-partial',
          viewerUserId: VIEWER,
          appBlockId: APP,
          appOwnerUserId: OWNER,
          status: 'accrued',
          feeBuzz: 17,
          buzzType: 'yellow',
          accruedAt: TODAY,
        },
        {
          workflowId: 'wf-full',
          viewerUserId: VIEWER,
          appBlockId: APP,
          appOwnerUserId: OWNER,
          status: 'accrued',
          feeBuzz: 19,
          buzzType: 'yellow',
          accruedAt: YESTERDAY,
        },
      ],
    });
    const debit = (n: number, amount: number, accountType: string) => ({
      type: 'debit',
      amount,
      id: txId(n),
      accountType,
    });
    h.getOrchestratorWorkflowCharges.mockImplementation(async (id) => {
      if (id === 'wf-partial')
        return {
          found: true,
          status: 'succeeded',
          transactions: [debit(1, 211, 'yellow'), debit(2, 43, 'blue')],
        };
      if (id === 'wf-full')
        return { found: true, status: 'succeeded', transactions: [debit(3, 89, 'green')] };
      return { found: true, status: 'processing', transactions: [debit(4, 61, 'yellow')] };
    });
    ledger.set(`refund-${txId(2)}`, { toAccountId: VIEWER, amount: 43 });
    ledger.set(`refund-${txId(3)}`, { toAccountId: VIEWER, amount: 89 });
    ledger.set('block-author-fee-reversal-wf-full', {
      fromAccountId: 0,
      toAccountId: VIEWER,
      toAccountType: 'yellow',
      amount: 19,
    });
  });

  it('legs, fee state, refund state and refund ids, in list order', async () => {
    const { status, body } = await call({ userId: VIEWER });
    expect(status).toBe(200);
    const [partial, full, running] = body.workflows;

    expect(partial).toMatchObject({
      workflowId: 'wf-partial',
      app: { id: APP, name: APP_NAME },
      submittedAt: TODAY.toISOString(),
      recordedStatus: 'succeeded',
      orchestratorStatus: 'succeeded',
      charges: [
        { transactionId: txId(1), amount: 211, buzzType: 'yellow', refundedBy: null },
        {
          transactionId: txId(2),
          amount: 43,
          buzzType: 'blue',
          refundedBy: 'moderator',
          refundTransactionId: `refund-${txId(2)}`,
        },
      ],
      authorFee: { state: 'unsettled', feeBuzz: 17, accruedAt: TODAY.toISOString() },
      refundState: 'partial',
      refundTransactionIds: [`refund-${txId(2)}`],
      refundBlocker: null,
    });

    expect(full).toMatchObject({
      workflowId: 'wf-full',
      authorFee: { state: 'reversed', feeBuzz: 19 },
      refundState: 'full',
      refundTransactionIds: [`refund-${txId(3)}`, 'block-author-fee-reversal-wf-full'],
    });

    expect(running).toMatchObject({
      workflowId: 'wf-running',
      orchestratorStatus: 'processing',
      authorFee: { state: 'none' },
      refundState: 'none',
      refundBlocker: 'not-terminal',
    });
  });

  it('a fee whose accrual day has closed reads as settled', async () => {
    ledger.delete('block-author-fee-reversal-wf-full');
    const { body } = await call({ userId: VIEWER });
    expect(body.workflows[1].authorFee).toMatchObject({ state: 'settled', feeBuzz: 19 });
    expect(body.workflows[1].refundState).toBe('partial');
  });

  it('a workflow whose charges cannot be read says so instead of guessing', async () => {
    h.getOrchestratorWorkflowCharges.mockRejectedValue(new Error('orchestrator unavailable'));
    const { status, body } = await call({ userId: VIEWER });
    expect(status).toBe(200);
    expect(body.workflows[0]).toMatchObject({
      workflowId: 'wf-partial',
      orchestratorStatus: null,
      refundBlocker: 'lookup-failed',
      lookupError: 'orchestrator unavailable',
    });
    expect(body.workflows[0].charges).toBeUndefined();
  });
});

// The lookup's `refundBlocker` is the refund planner's own skip reason — one list, not a copy. So
// each case is checked twice: against the literal reason, and against what the refund endpoint's
// planner (`planAppWorkflowRefunds`) decides for the very same fixture.
describe('refundBlocker is the refund planner’s skip reason', () => {
  const WF = 'wf-skip';
  const debit = (n: number, amount: number, accountType = 'yellow', id = txId(n)) => ({
    type: 'debit',
    amount,
    id,
    accountType,
  });
  const recorded = (userId = VIEWER) => ({
    workflowId: WF,
    userId,
    appBlockId: APP,
    status: 'succeeded',
    submittedAt: TODAY,
  });
  const charges = (status: string, transactions: unknown[]) => ({
    found: true,
    status,
    transactions,
  });

  // A Record, so adding a SkipReason without a case here fails the test typecheck.
  const setups: Record<SkipReason, () => void> = {
    'not-app-blocks': () =>
      h.getAppWorkflowRecords.mockResolvedValue({ workflows: [], spends: [], fees: [] }),
    'workflow-not-found': () =>
      h.getOrchestratorWorkflowCharges.mockResolvedValue({ found: false }),
    'mixed-users': () =>
      h.getAppWorkflowRecords.mockResolvedValue({
        workflows: [recorded()],
        spends: [{ ...recorded(OWNER), attributedAt: TODAY }],
        fees: [],
      }),
    'not-terminal': () =>
      h.getOrchestratorWorkflowCharges.mockResolvedValue(charges('processing', [debit(10, 41)])),
    'not-succeeded': () =>
      h.getOrchestratorWorkflowCharges.mockResolvedValue(charges('failed', [debit(14, 53)])),
    'charges-unreadable': () => {
      h.getAppWorkflowRecords.mockResolvedValue({
        workflows: [recorded()],
        spends: [{ ...recorded(), buzzAmount: 59, attributedAt: TODAY }],
        fees: [],
      });
      h.getOrchestratorWorkflowCharges.mockResolvedValue(charges('succeeded', []));
    },
    'unsupported-charge': () =>
      h.getOrchestratorWorkflowCharges.mockResolvedValue(
        charges('succeeded', [debit(11, 43, 'yellow', 'fund-17')])
      ),
    'orchestrator-partial-refund': () =>
      h.getOrchestratorWorkflowCharges.mockResolvedValue(
        charges('succeeded', [
          debit(12, 97),
          { type: 'credit', amount: 31, id: 'credit-1', accountType: 'yellow' },
        ])
      ),
    'no-charges': () =>
      h.getOrchestratorWorkflowCharges.mockResolvedValue(charges('succeeded', [])),
    'lookup-failed': () =>
      h.getOrchestratorWorkflowCharges.mockRejectedValue(new Error('orchestrator unavailable')),
  };
  const cases = Object.entries(setups) as [SkipReason, () => void][];

  beforeEach(() => {
    h.listAppWorkflowIdsForUser.mockResolvedValue([WF]);
    h.getAppWorkflowRecords.mockResolvedValue({ workflows: [recorded()], spends: [], fees: [] });
    h.getOrchestratorWorkflowCharges.mockResolvedValue(charges('succeeded', [debit(13, 47)]));
  });

  it('covers every skip reason the planner exports', () => {
    expect(cases.map(([reason]) => reason).sort()).toEqual([...SKIP_REASONS].sort());
  });

  it.each(cases)('%s', async (reason, setup) => {
    setup();
    const { status, body } = await call({ userId: VIEWER });
    expect(status).toBe(200);
    expect(body.workflows[0].refundBlocker).toBe(reason);
    const planned = await planAppWorkflowRefunds([WF]);
    expect(planned.plans[0]).toMatchObject({ outcome: 'skip', reason });
  });

  it('control: a refundable workflow has no blocker, and the planner would refund it', async () => {
    const { body } = await call({ userId: VIEWER });
    expect(body.workflows[0].refundBlocker).toBeNull();
    const planned = await planAppWorkflowRefunds([WF]);
    expect(planned.plans[0].outcome).toBe('refund');
  });
});
