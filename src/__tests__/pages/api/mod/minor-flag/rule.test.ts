import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RESOLUTION_NOTE_MAX_LENGTH } from '@civitai/shared/resolution-reasons';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as MinorHash from '~/server/services/minor-hash.service';
import type * as ModelService from '~/server/services/model.service';
import type * as PoiMinor from '~/server/services/text-scan/actions/model-poi-minor';
import type * as AppealTextHash from '~/server/services/text-scan/actions/appeal-text-hash';

const m = vi.hoisted(() => ({
  confirm: vi.fn(),
  revert: vi.fn(),
  setMinor: vi.fn(),
  stamp: vi.fn(),
  grantPoi: vi.fn(),
  grantHash: vi.fn(),
  settle: vi.fn(),
  session: { user: { id: 7, isModerator: true, permissions: [], bannedAt: null } },
}));

vi.mock('~/server/auth/bearer-token', () => ({ getSessionFromBearerToken: vi.fn() }));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => m.session),
}));
vi.mock('~/server/clickhouse/client', () => ({
  Tracker: class {
    retoolAudit = vi.fn();
    userActivity = vi.fn();
  },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/services/minor-hash.service', async (importOriginal) => ({
  ...(await importOriginal<typeof MinorHash>()),
  confirmMinorHashAutoFlag: m.confirm,
  revertMinorHashAutoFlag: m.revert,
}));
vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelService>()),
  setModelMinor: m.setMinor,
}));
vi.mock('~/server/services/text-scan/actions/model-poi-minor', async (importOriginal) => ({
  ...(await importOriginal<typeof PoiMinor>()),
  stampModelTextScanAppeal: m.stamp,
  grantModelTextScanPoi: m.grantPoi,
}));
vi.mock('~/server/services/text-scan/actions/appeal-text-hash', async (importOriginal) => ({
  ...(await importOriginal<typeof AppealTextHash>()),
  loadGrantTextHash: m.grantHash,
  settleFlagAppealsAfterModeratorLift: m.settle,
}));

import handler from '~/pages/api/mod/minor-flag/rule';

function call(body: Record<string, unknown>) {
  const req = { method: 'POST', headers: {}, body, query: {} } as Parameters<typeof handler>[0];
  let statusCode = 200;
  let payload: unknown;
  const res = {
    status(c: number) {
      statusCode = c;
      return res;
    },
    json: (p: unknown) => {
      payload = p;
      return res;
    },
    setHeader: vi.fn(),
    end: () => res,
  } as unknown as Parameters<typeof handler>[1];
  return handler(req, res).then(() => ({ status: statusCode, payload }));
}

const flagged = (label: 'minor' | 'poi', extra: Record<string, unknown> = {}) => ({
  meta: { textScanFlags: { [label]: { textHash: 'h-1' } }, ...extra },
});
const body = { modelId: 42, textHash: 'h-1' };

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.appeal.findFirst.mockResolvedValue(null);
  m.grantHash.mockResolvedValue('grant-h');
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  redisMock.sysRedis.ttl.mockResolvedValue(60);
  redisMock.sysRedis.eval.mockResolvedValue(1);
});

describe('minorFlag.rule', () => {
  it('keeps a minor flag as the acting moderator', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(flagged('minor'));
    const res = await call({
      ...body,
      label: 'minor',
      keep: true,
      resolvedReason: 'detection-correct',
      internalNotes: 'clear',
    });
    expect(res.status).toBe(200);
    expect(m.confirm).toHaveBeenCalledWith({
      modelId: 42,
      userId: 7,
      reason: 'detection-correct',
      note: 'clear',
    });
    expect(res.payload).toMatchObject({ ruled: 'kept', label: 'minor', modelId: 42 });
  });

  it('keeps a real-person flag by stamping the moderator upheld ruling', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(flagged('poi'));
    await call({ ...body, label: 'poi', keep: true, resolvedReason: 'detection-correct' });
    expect(m.stamp).toHaveBeenCalledWith({
      modelId: 42,
      userId: 7,
      decision: 'appealUpheld',
      labels: ['poi'],
      via: 'moderator',
      reason: 'detection-correct',
      note: undefined,
    });
  });

  it('lifts a minor flag that has an auto-flag snapshot by reverting it', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(
      flagged('minor', { minorFlagSnapshot: { source: 'auto' } })
    );
    const res = await call({
      ...body,
      label: 'minor',
      keep: 'false',
      resolvedReason: 'not-a-minor',
    });
    expect(m.revert).toHaveBeenCalledWith({
      modelId: 42,
      userId: 7,
      recordTextScanRuling: true,
      reason: 'not-a-minor',
      note: undefined,
    });
    expect(m.setMinor).not.toHaveBeenCalled();
    expect(res.payload).toMatchObject({ ruled: 'lifted' });
  });

  it('lifts a minor flag without a snapshot by clearing the flag directly', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(flagged('minor'));
    await call({ ...body, label: 'minor', keep: false, resolvedReason: 'terms-misread' });
    expect(m.setMinor).toHaveBeenCalledWith({
      id: 42,
      minor: false,
      userId: 7,
      isModerator: true,
      recordTextScanRuling: true,
      reason: 'terms-misread',
      note: undefined,
    });
    expect(m.revert).not.toHaveBeenCalled();
  });

  it('lifts a real-person flag against the text the scan read, then settles appeals', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(flagged('poi'));
    await call({ ...body, label: 'poi', keep: false, resolvedReason: 'not-a-real-person' });
    expect(m.grantHash).toHaveBeenCalledWith('Model', 42, 'poi');
    expect(m.grantPoi).toHaveBeenCalledWith({
      modelId: 42,
      userId: 7,
      grantHash: 'grant-h',
      via: 'moderator',
      reason: 'not-a-real-person',
      note: undefined,
    });
    expect(m.settle).toHaveBeenCalledWith({
      modelId: 42,
      userId: 7,
      liftedLabels: ['poi'],
      recordRulings: false,
    });
  });

  it('lets a lift proceed while the owner has an open appeal', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(flagged('poi'));
    dbMock.dbWrite.appeal.findFirst.mockResolvedValue({ id: 1 });
    expect((await call({ ...body, label: 'poi', keep: false })).status).toBe(200);
    expect(m.grantPoi).toHaveBeenCalled();
  });

  it('refuses a keep while the owner has an open appeal', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(flagged('minor'));
    dbMock.dbWrite.appeal.findFirst.mockResolvedValue({ id: 1 });
    expect((await call({ ...body, label: 'minor', keep: true })).status).toBe(400);
    expect(m.confirm).not.toHaveBeenCalled();
  });

  it('refuses a flag that is not on the model', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(flagged('minor'));
    expect((await call({ ...body, label: 'poi', keep: true })).status).toBe(400);
    dbMock.dbWrite.model.findUnique.mockResolvedValue(null);
    expect((await call({ ...body, label: 'poi', keep: true })).status).toBe(400);
    expect(m.stamp).not.toHaveBeenCalled();
  });

  it('refuses a ruling made on text that has since changed', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(flagged('minor'));
    expect((await call({ ...body, textHash: 'h-0', label: 'minor', keep: false })).status).toBe(
      400
    );
    expect(m.setMinor).not.toHaveBeenCalled();
    expect(m.revert).not.toHaveBeenCalled();
  });

  it('refuses a real-person lift when the model text cannot be read', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(flagged('poi'));
    m.grantHash.mockResolvedValue(null);
    expect((await call({ ...body, label: 'poi', keep: false })).status).toBe(400);
    expect(m.grantPoi).not.toHaveBeenCalled();
  });

  it.each([
    ['a keep reason on a lift', { keep: false, resolvedReason: 'detection-correct' }],
    ['a lift reason on a keep', { keep: true, resolvedReason: 'not-a-minor' }],
    ['Other without a note', { keep: true, resolvedReason: 'other' }],
    ['a real-person reason on a minor flag', { keep: false, resolvedReason: 'not-a-real-person' }],
    [
      'a note over the limit',
      {
        keep: true,
        resolvedReason: 'other',
        internalNotes: 'x'.repeat(RESOLUTION_NOTE_MAX_LENGTH + 1),
      },
    ],
  ])('refuses %s before touching the model', async (_, ruling) => {
    expect((await call({ ...body, label: 'minor', ...ruling })).status).toBe(400);
    expect(dbMock.dbWrite.model.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a ruling that does not name the text it was made on', async () => {
    expect((await call({ modelId: 42, label: 'minor', keep: true })).status).toBe(400);
  });

  it('answers a service refusal with a client error, not a 500', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(flagged('minor'));
    m.confirm.mockRejectedValue(new TRPCError({ code: 'BAD_REQUEST', message: 'nope' }));
    const { status } = await call({ ...body, label: 'minor', keep: true });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
  });
});
