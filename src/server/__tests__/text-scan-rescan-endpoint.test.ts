import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as ClickhouseModule from '~/server/clickhouse/client';
import type * as ModeModule from '~/server/services/text-scan/mode';
import type * as SubmitModule from '~/server/services/text-scan/submit';

const { session, mockAudit } = vi.hoisted(() => ({
  session: { current: null as null | { user: Record<string, unknown> } },
  mockAudit: vi.fn(),
}));

vi.mock('~/server/auth/bearer-token', () => ({ getSessionFromBearerToken: vi.fn() }));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => session.current),
}));
vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseModule>()),
  Tracker: class {
    retoolAudit = mockAudit;
  },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/services/text-scan/submit', async (importOriginal) => ({
  ...(await importOriginal<typeof SubmitModule>()),
  scanEntity: vi.fn(),
}));
vi.mock('~/server/services/text-scan/mode', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeModule>()),
  getTextScanMode: vi.fn(),
}));

const handler = (await import('~/pages/api/admin/temp/text-scan-rescan')).default;
const { scanEntity } = await import('~/server/services/text-scan/submit');
const { getTextScanMode } = await import('~/server/services/text-scan/mode');

function run(body: unknown, query: Record<string, string> = {}) {
  const req = { method: 'POST', query, headers: {}, body };
  let statusCode = 200;
  let payload: unknown;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(data: unknown) {
      payload = data;
      return res;
    },
    setHeader: vi.fn(),
    end: () => res,
  };
  return Promise.resolve(handler(req as never, res as never)).then(() => ({
    status: statusCode,
    body: payload as Record<string, unknown>,
  }));
}

const MOD = 990000321;
beforeEach(() => {
  vi.clearAllMocks();
  session.current = { user: { id: MOD, isModerator: true, bannedAt: null, permissions: [] } };
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  redisMock.sysRedis.ttl.mockResolvedValue(60);
});

describe('text-scan-rescan', () => {
  it('refuses a caller who is not a signed-in moderator, token or not', async () => {
    session.current = null;
    expect(
      (await run({ entityType: 'Post', entityIds: [1] }, { token: 'test-webhook-token' })).status
    ).toBe(401);
    session.current = { user: { id: 5, isModerator: false, bannedAt: null } };
    expect((await run({ entityType: 'Post', entityIds: [1] })).status).toBe(403);
    expect(getTextScanMode).not.toHaveBeenCalled();
  });

  it('rejects an entity type text-scan does not have', async () => {
    expect((await run({ entityType: 'Image', entityIds: [1] })).status).toBe(400);
    expect(getTextScanMode).not.toHaveBeenCalled();
  });

  it('dry run evaluates modes and submits nothing', async () => {
    vi.mocked(getTextScanMode).mockImplementation(async (_t, id) =>
      id === 1 ? 'active' : 'shadow'
    );
    const res = await run({ entityType: 'Post', entityIds: [1, 2] });
    expect(res.body).toMatchObject({ dryRun: true, byMode: { active: 1, shadow: 1 } });
    expect(scanEntity).not.toHaveBeenCalled();
  });

  it('rescans active ids only, without force unless asked', async () => {
    vi.mocked(getTextScanMode).mockImplementation(async (_t, id) =>
      id === 2 ? 'shadow' : 'active'
    );
    vi.mocked(scanEntity)
      .mockResolvedValueOnce({ status: 'submitted', workflowId: 'wf' })
      .mockResolvedValueOnce({ status: 'skipped', reason: 'unchanged' });
    const res = await run({
      entityType: 'Post',
      entityIds: [1, 2, 3],
      dryRun: false,
      concurrency: 1,
    });
    expect(vi.mocked(scanEntity).mock.calls.map((c) => c[0])).toEqual([
      { entityType: 'Post', entityId: 1, force: false },
      { entityType: 'Post', entityId: 3, force: false },
    ]);
    expect(res.body).toMatchObject({
      dryRun: false,
      force: false,
      byStatus: { submitted: 1, 'skipped/unchanged': 1, 'not-active': 1 },
    });
  });

  it('passes force through when asked', async () => {
    vi.mocked(getTextScanMode).mockResolvedValue('active');
    vi.mocked(scanEntity).mockResolvedValue({ status: 'submitted', workflowId: 'wf' });
    await run({ entityType: 'Post', entityIds: [1], dryRun: false, force: true });
    expect(scanEntity).toHaveBeenCalledWith({ entityType: 'Post', entityId: 1, force: true });
  });

  it('writes an audit row for the call', async () => {
    vi.mocked(getTextScanMode).mockResolvedValue('active');
    await run({ entityType: 'Post', entityIds: [1] });
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'textScan.rescan', outcome: 'ok' })
    );
  });
});
