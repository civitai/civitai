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

const flagged = (
  label: 'minor' | 'poi',
  extra: Record<string, unknown> = {},
  entry: Record<string, unknown> = {},
  live = true
) => ({
  meta: {
    textScanFlags: { [label]: { workflowId: 'wf-1', textHash: 'h-1', ...entry } },
    ...extra,
  },
  minor: label === 'minor' && live,
  poi: label === 'poi' && live,
});
const body = { modelId: 42, textHash: 'h-1' };
const errorOf = (res: { payload: unknown }) => (res.payload as { message?: string }).message ?? '';
const nothingRuled = () => {
  for (const fn of [m.confirm, m.revert, m.setMinor, m.stamp, m.grantPoi])
    expect(fn).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.appeal.findFirst.mockResolvedValue(null);
  m.confirm.mockResolvedValue({ hadVerdict: true, stamped: true });
  m.stamp.mockResolvedValue(1);
  m.grantPoi.mockResolvedValue(true);
  m.revert.mockResolvedValue({ rolledBack: 1 });
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
    expect(m.stamp).toHaveBeenCalledWith({
      modelId: 42,
      userId: 7,
      decision: 'appealUpheld',
      labels: ['minor'],
      via: 'moderator',
      reason: 'detection-correct',
      note: 'clear',
      expectTextHash: 'h-1',
    });
    expect(m.confirm).toHaveBeenCalledWith({
      modelId: 42,
      userId: 7,
      recordTextScanRuling: false,
    });
    expect(m.stamp.mock.invocationCallOrder[0]).toBeLessThan(m.confirm.mock.invocationCallOrder[0]);
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
      expectTextHash: 'h-1',
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
      recordTextScanRuling: false,
      skipRefusal: true,
    });
    expect(m.stamp).toHaveBeenCalledWith({
      modelId: 42,
      userId: 7,
      decision: 'appealGranted',
      labels: ['minor'],
      grantHashes: { minor: 'h-1' },
      via: 'moderator',
      reason: 'not-a-minor',
      note: undefined,
      expectTextHash: 'h-1',
    });
    expect(m.revert.mock.invocationCallOrder[0]).toBeLessThan(m.stamp.mock.invocationCallOrder[0]);
    expect(m.stamp.mock.invocationCallOrder[0]).toBeLessThan(m.settle.mock.invocationCallOrder[0]);
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
      recordTextScanRuling: false,
    });
    expect(m.stamp).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'appealGranted',
        labels: ['minor'],
        grantHashes: { minor: 'h-1' },
        reason: 'terms-misread',
        expectTextHash: 'h-1',
      })
    );
    expect(m.setMinor.mock.invocationCallOrder[0]).toBeLessThan(
      m.stamp.mock.invocationCallOrder[0]
    );
    expect(m.settle).toHaveBeenCalledWith({
      modelId: 42,
      userId: 7,
      liftedLabels: ['minor'],
      recordRulings: false,
    });
    expect(m.revert).not.toHaveBeenCalled();
  });

  it('lifts a real-person flag against the text the moderator ruled on, then settles appeals', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(flagged('poi'));
    await call({ ...body, label: 'poi', keep: false, resolvedReason: 'not-a-real-person' });
    expect(m.grantPoi).toHaveBeenCalledWith({
      modelId: 42,
      userId: 7,
      grantHash: 'h-1',
      via: 'moderator',
      reason: 'not-a-real-person',
      note: undefined,
      expectTextHash: 'h-1',
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

  it('lets a minor lift proceed while the owner has an open appeal', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(
      flagged('minor', { minorFlagSnapshot: { source: 'auto' } })
    );
    dbMock.dbWrite.appeal.findFirst.mockResolvedValue({ id: 1 });
    const res = await call({ ...body, label: 'minor', keep: false });
    expect(res.status).toBe(200);
    expect(m.revert).toHaveBeenCalled();
    expect(res.payload).toMatchObject({ ruled: 'lifted', label: 'minor' });
  });

  it('refuses a keep while the owner has an open appeal', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(flagged('minor'));
    dbMock.dbWrite.appeal.findFirst.mockResolvedValue({ id: 1 });
    const res = await call({ ...body, label: 'minor', keep: true });
    expect(res.status).toBe(400);
    expect(errorOf(res)).toContain('open appeal');
    expect(m.confirm).not.toHaveBeenCalled();
  });

  it('refuses a flag that is not on the model', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(flagged('minor'));
    const other = await call({ ...body, label: 'poi', keep: true });
    expect(other.status).toBe(400);
    expect(errorOf(other)).toContain('No text-scan poi flag');
    dbMock.dbWrite.model.findUnique.mockResolvedValue(null);
    const missing = await call({ ...body, label: 'poi', keep: true });
    expect(missing.status).toBe(400);
    expect(errorOf(missing)).toContain('No text-scan poi flag');
    expect(m.stamp).not.toHaveBeenCalled();
  });

  it('refuses a hash-only auto-flag: this endpoint rules on text-scan flags only', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue({
      meta: { minorFlagSnapshot: { source: 'auto' } },
    });
    const res = await call({ ...body, label: 'minor', keep: false });
    expect(res.status).toBe(400);
    expect(errorOf(res)).toContain('hash flags are confirmed or reverted from the queue');
    nothingRuled();
  });

  it('refuses a ruling made on text that has since changed', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(flagged('minor'));
    const res = await call({ ...body, textHash: 'h-0', label: 'minor', keep: false });
    expect(res.status).toBe(400);
    expect(errorOf(res)).toContain('text changed');
    nothingRuled();
  });

  it('refuses a keep on a flag that was lifted, without stamping', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(
      flagged('poi', {}, { appealGranted: { textHash: 'h-1' } })
    );
    const res = await call({ ...body, label: 'poi', keep: true });
    expect(res.status).toBe(400);
    expect(errorOf(res)).toContain('no longer in force');
    nothingRuled();
  });

  it('refuses a ruling when the model column no longer carries the flag', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(flagged('poi', {}, {}, false));
    const res = await call({ ...body, label: 'poi', keep: false });
    expect(res.status).toBe(400);
    expect(errorOf(res)).toContain('no longer in force');
    nothingRuled();
  });

  it('refuses to lift minor on a cleared column with a stale snapshot, without rolling back', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(
      flagged('minor', { minorFlagSnapshot: { source: 'auto' } }, {}, false)
    );
    const res = await call({ ...body, label: 'minor', keep: false });
    expect(res.status).toBe(400);
    nothingRuled();
  });

  it('refuses a ruling on the old text while a re-detection on newer text is held', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(
      flagged('poi', {}, { redetected: { workflowId: 'wf-2', textHash: 'h-2' } })
    );
    const res = await call({ ...body, label: 'poi', keep: false });
    expect(res.status).toBe(400);
    expect(errorOf(res)).toContain('queue');
    nothingRuled();
  });

  it('does not answer lifted or settle appeals when the poi grant did not apply', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(flagged('poi'));
    m.grantPoi.mockResolvedValue(false);
    const res = await call({ ...body, label: 'poi', keep: false });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.payload).not.toMatchObject({ ruled: 'lifted' });
    expect(m.settle).not.toHaveBeenCalled();
  });

  it('does not answer lifted when the minor revert rolled nothing back', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(
      flagged('minor', { minorFlagSnapshot: { source: 'auto' } })
    );
    m.revert.mockResolvedValue({ rolledBack: 0, failed: 1 });
    const res = await call({ ...body, label: 'minor', keep: false });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.payload).not.toMatchObject({ ruled: 'lifted' });
    expect(m.stamp).not.toHaveBeenCalled();
    expect(m.settle).not.toHaveBeenCalled();
  });

  it.each([
    ['with a snapshot', { minorFlagSnapshot: { source: 'auto' } }],
    ['without a snapshot', {}],
  ])(
    'says the flag was lifted but not recorded when the post-lift stamp misses (%s)',
    async (_, extra) => {
      dbMock.dbWrite.model.findUnique.mockResolvedValue(flagged('minor', extra));
      m.stamp.mockResolvedValue(0);
      const res = await call({ ...body, label: 'minor', keep: false });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(errorOf(res)).toContain('lifted but the ruling was not recorded');
      expect(res.payload).not.toMatchObject({ ruled: 'lifted' });
      expect(m.settle).not.toHaveBeenCalled();
    }
  );

  it('refuses a poi keep whose stamp touched no row', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(flagged('poi'));
    m.stamp.mockResolvedValue(0);
    const res = await call({ ...body, label: 'poi', keep: true });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.payload).not.toMatchObject({ ruled: 'kept' });
  });

  it('refuses a minor keep whose guarded stamp changed no row, without signing the flag off', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(flagged('minor'));
    m.stamp.mockResolvedValue(0);
    const res = await call({ ...body, label: 'minor', keep: true });
    expect(res.status).toBe(400);
    expect(errorOf(res)).toContain('changed while you were ruling');
    expect(m.confirm).not.toHaveBeenCalled();
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

  it('accepts a lift with no reason and stamps none', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(flagged('poi'));
    const res = await call({ ...body, label: 'poi', keep: false });
    expect(res.status).toBe(200);
    expect(m.grantPoi).toHaveBeenCalledTimes(1);
    const arg = m.grantPoi.mock.calls[0][0];
    expect(arg.reason).toBeUndefined();
    expect(arg.note).toBeUndefined();
  });

  it('refuses a reason that was sent but does not fit, with the validator message', async () => {
    const res = await call({ ...body, label: 'minor', keep: true, resolvedReason: 'not-a-minor' });
    expect(res.status).toBe(400);
    expect(errorOf(res)).toContain('"not-a-minor" is not a reason for Kept.');
    expect(dbMock.dbWrite.model.findUnique).not.toHaveBeenCalled();
  });

  it('refuses while another request holds the flag lock, without ruling', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(flagged('poi'));
    redisMock.sysRedis.set.mockResolvedValueOnce(null);
    const res = await call({ ...body, label: 'poi', keep: false });
    expect(res.status).toBe(400);
    expect(errorOf(res)).toContain('being resolved');
    nothingRuled();
    expect(dbMock.dbWrite.model.findUnique).not.toHaveBeenCalled();
    expect(redisMock.sysRedis.eval).not.toHaveBeenCalled();
  });

  it('releases the flag lock when the ruling throws', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(flagged('poi'));
    m.grantPoi.mockRejectedValueOnce(new Error('db down'));
    const res = await call({ ...body, label: 'poi', keep: false });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(redisMock.sysRedis.eval).toHaveBeenCalledTimes(1);
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
