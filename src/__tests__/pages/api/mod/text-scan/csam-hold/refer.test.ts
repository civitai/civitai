import type * as Decision from '~/server/services/text-scan/csam-hold-decision';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const mocks = vi.hoisted(() => ({
  session: { user: { id: 7, isModerator: true, permissions: [], bannedAt: null, roles: [] } },
  hasModeratorGrant: vi.fn<(...a: unknown[]) => Promise<boolean>>(),
  referCsamHoldToLead: vi.fn(),
}));

vi.mock('~/server/auth/bearer-token', () => ({ getSessionFromBearerToken: vi.fn() }));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => mocks.session),
}));
vi.mock('~/server/clickhouse/client', () => ({
  Tracker: class {
    retoolAudit = vi.fn();
    userActivity = vi.fn();
  },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/services/moderator-grants', () => ({
  hasModeratorGrant: (...a: unknown[]) => mocks.hasModeratorGrant(...a),
}));
vi.mock('~/server/services/text-scan/csam-hold-decision', async (importOriginal) => ({
  ...(await importOriginal<typeof Decision>()),
  referCsamHoldToLead: mocks.referCsamHoldToLead,
}));

import handler from '~/pages/api/mod/text-scan/csam-hold/refer';

async function call(body: Record<string, unknown>) {
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
  await handler(req, res);
  return { status: statusCode, body: payload };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasModeratorGrant.mockResolvedValue(true);
  mocks.referCsamHoldToLead.mockResolvedValue({ holdId: 12, status: 'Pending' });
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  redisMock.sysRedis.ttl.mockResolvedValue(60);
});

describe('textScan.referCsamHold', () => {
  it('refuses a moderator without the csam permission, before referring', async () => {
    mocks.hasModeratorGrant.mockResolvedValue(false);

    expect((await call({ holdId: 12, textHash: 'h-1', note: 'unsure' })).status).toBe(403);
    expect(mocks.hasModeratorGrant).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7 }),
      'csam.report.file'
    );
    expect(mocks.referCsamHoldToLead).not.toHaveBeenCalled();
  });

  it('refers the hold as the calling moderator, with its text hash and note', async () => {
    const res = await call({ holdId: 12, textHash: 'h-1', note: 'unsure' });

    expect(res.status).toBe(200);
    expect(mocks.referCsamHoldToLead).toHaveBeenCalledWith({
      holdId: 12,
      textHash: 'h-1',
      note: 'unsure',
      actor: { id: 7 },
    });
  });
});
