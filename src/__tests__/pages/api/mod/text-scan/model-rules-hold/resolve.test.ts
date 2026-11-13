import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';
import '~/__tests__/mocks/redis.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { TRPCError } from '@trpc/server';
import {
  MODEL_RULES_MOVED_ON_MESSAGE,
  MODEL_RULES_STALE_HOLD_MESSAGE,
  MODEL_RULES_SUPERSEDED_MESSAGE,
  ModelRulesHoldRefusal,
} from '~/server/services/text-scan/model-rules-hold-decision';
import type * as DecisionModule from '~/server/services/text-scan/model-rules-hold-decision';

const mocks = vi.hoisted(() => ({
  session: { user: { id: 7, isModerator: true, permissions: [], bannedAt: null, roles: [] } },
  hasModeratorGrant: vi.fn<(...a: unknown[]) => Promise<boolean>>(),
  decide: vi.fn(),
  decideBatch: vi.fn(),
  tracker: { retoolAudit: vi.fn(), modelEvent: vi.fn() },
}));

vi.mock('~/server/auth/bearer-token', () => ({ getSessionFromBearerToken: vi.fn() }));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => mocks.session),
}));
vi.mock('~/server/clickhouse/client', () => ({
  Tracker: class {
    retoolAudit = mocks.tracker.retoolAudit;
    modelEvent = mocks.tracker.modelEvent;
  },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/services/moderator-grants', () => ({
  hasModeratorGrant: (...a: unknown[]) => mocks.hasModeratorGrant(...a),
}));
// Hand-listed: the real services pull search-index and cache graphs that build clients at load.
vi.mock('~/server/services/model.service', () => ({ unpublishModelById: vi.fn() }));
vi.mock('~/server/services/model-version.service', () => ({
  bustPublicModelResponseCache: vi.fn(),
}));
vi.mock('~/server/services/strike.service', () => ({ createStrike: vi.fn() }));
vi.mock('~/server/redis/caches', () => ({ dataForModelsCache: { refresh: vi.fn() } }));
vi.mock('~/server/services/text-scan/profiles/model.profile', () => ({
  loadModelScanSubjects: vi.fn(),
}));
vi.mock('~/server/services/text-scan/model-rules-hold-decision', async (importOriginal) => ({
  ...(await importOriginal<typeof DecisionModule>()),
  decideModelRulesHold: mocks.decide,
  decideModelRulesHoldBatch: mocks.decideBatch,
}));

import handler from '~/pages/api/mod/text-scan/model-rules-hold/resolve';

function call(body: Record<string, unknown>) {
  const req = { method: 'POST', headers: {}, body, query: {} } as Parameters<typeof handler>[0];
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
    end: () => res,
  } as unknown as Parameters<typeof handler>[1];
  return handler(req, res).then(() => ({ status: statusCode, body: payload }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasModeratorGrant.mockResolvedValue(true);
  mocks.decide.mockResolvedValue({ status: 'Confirmed', entityId: 9, userId: 5 });
  mocks.decideBatch.mockResolvedValue([
    { holdId: 1, ok: true, status: 'Dismissed', entityId: 9, userId: 5 },
    { holdId: 2, ok: false, stale: true, error: 'stale' },
  ]);
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  redisMock.sysRedis.ttl.mockResolvedValue(60);
});

describe('textScan.resolveModelRulesHold', () => {
  it('decides a hold as the signed-in moderator and reports the model and owner affected', async () => {
    const { status, body } = await call({
      holdId: 12,
      textHash: 'h-1',
      decision: 'confirm',
      note: 'ok',
    });
    expect(status).toBe(200);
    expect(mocks.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        holdId: 12,
        textHash: 'h-1',
        decision: 'confirm',
        note: 'ok',
        actor: { id: 7, isModerator: true },
      })
    );
    expect(body).toMatchObject({
      holdId: 12,
      status: 'Confirmed',
      decision: 'confirm',
      userId: 5,
    });
  });

  it('holds a strike to the user.strike grant, deciding nothing without it', async () => {
    mocks.hasModeratorGrant.mockResolvedValue(false);
    const { status } = await call({ holdId: 12, textHash: 'h-1', decision: 'confirm_strike' });
    expect(status).toBe(403);
    expect(mocks.hasModeratorGrant).toHaveBeenCalledWith(expect.anything(), 'user.strike');
    expect(mocks.decide).not.toHaveBeenCalled();
  });

  it('lets a moderator without the strike grant confirm or dismiss', async () => {
    mocks.hasModeratorGrant.mockResolvedValue(false);
    for (const decision of ['confirm', 'dismiss_not_subject', 'dismiss_allowed'])
      expect((await call({ holdId: 12, textHash: 'h-1', decision })).status).toBe(200);
  });

  it('strikes with the grant', async () => {
    const { status } = await call({ holdId: 12, textHash: 'h-1', decision: 'confirm_strike' });
    expect(status).toBe(200);
    expect(mocks.decide).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'confirm_strike' })
    );
  });

  it('refuses a decision with no text hash, and a decision that is not one of the four', async () => {
    expect((await call({ holdId: 12, decision: 'confirm' })).status).toBe(400);
    expect((await call({ holdId: 12, textHash: 'h', decision: 'dismiss' })).status).toBe(400);
    expect(mocks.decide).not.toHaveBeenCalled();
  });

  it('refuses a signed-in user who is not a moderator', async () => {
    mocks.session.user.isModerator = false;
    try {
      expect((await call({ holdId: 12, textHash: 'h', decision: 'confirm' })).status).toBe(403);
      expect(mocks.decide).not.toHaveBeenCalled();
    } finally {
      mocks.session.user.isModerator = true;
    }
  });

  it('rules a batch without a strike and reports each hold', async () => {
    const holds = [
      { holdId: 1, textHash: 'a' },
      { holdId: 2, textHash: 'b' },
    ];
    const { status, body } = await call({ holds, decision: 'dismiss_allowed' });
    expect(status).toBe(200);
    expect(mocks.decideBatch).toHaveBeenCalledWith(
      expect.objectContaining({ holds, decision: 'dismiss_allowed' })
    );
    expect(body).toMatchObject({
      decision: 'dismiss_allowed',
      results: [
        { holdId: 1, ok: true },
        { holdId: 2, ok: false, stale: true },
      ],
    });
    expect((await call({ holds, decision: 'confirm_strike' })).status).toBe(400);
  });

  it('audits a batch refusal as refused and an unexpected failure as error', async () => {
    mocks.decideBatch.mockResolvedValueOnce([
      { holdId: 1, ok: false, stale: false, refused: true, error: 'moved on' },
      { holdId: 2, ok: false, stale: false, refused: false, error: 'Could not apply.' },
    ]);
    await call({
      holds: [
        { holdId: 1, textHash: 'a' },
        { holdId: 2, textHash: 'b' },
      ],
      decision: 'confirm',
    });
    const outcome = (holdId: number) =>
      loggingMock.logToAxiom.mock.calls.find(([l]) => l.holdId === holdId)?.[0].outcome;
    expect(outcome(1)).toBe('refused');
    expect(outcome(2)).toBe('error');
  });

  it.each([
    ['stale', new ModelRulesHoldRefusal('CONFLICT', MODEL_RULES_STALE_HOLD_MESSAGE)],
    ['refused', new ModelRulesHoldRefusal('CONFLICT', MODEL_RULES_SUPERSEDED_MESSAGE)],
    ['refused', new ModelRulesHoldRefusal('CONFLICT', MODEL_RULES_MOVED_ON_MESSAGE)],
    ['error', new TRPCError({ code: 'CONFLICT', message: 'The decision lost its claim.' })],
    ['error', new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'boom' })],
    ['error', new Error('db down')],
  ])('audits a single decision that fails as %s, as a batch does', async (outcome, failure) => {
    mocks.decide.mockRejectedValueOnce(failure);
    await call({ holdId: 12, textHash: 'h-1', decision: 'confirm' });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'model-rules-hold-decision',
        holdId: 12,
        outcome,
        moderatorId: 7,
      })
    );
  });

  it('sends an unexpected single-decision failure to the fault log, never a refusal', async () => {
    mocks.decide.mockRejectedValueOnce(
      new TRPCError({ code: 'CONFLICT', message: 'The decision lost its claim.' })
    );
    await call({ holdId: 12, textHash: 'h-1', decision: 'confirm' });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', holdId: 12 })
    );
  });

  it('keeps a benign single-decision refusal out of the fault log', async () => {
    mocks.decide.mockRejectedValueOnce(
      new ModelRulesHoldRefusal('CONFLICT', MODEL_RULES_SUPERSEDED_MESSAGE)
    );
    await call({ holdId: 12, textHash: 'h-1', decision: 'confirm' });
    expect(loggingMock.logToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error' })
    );
  });
});
