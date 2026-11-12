import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as ImageService from '~/server/services/image.service';

const { mockReport, retoolAudit, session } = vi.hoisted(() => ({
  mockReport: vi.fn(),
  retoolAudit: vi.fn(),
  session: { user: { id: 7, isModerator: true, permissions: [], bannedAt: null } },
}));

vi.mock('~/server/auth/bearer-token', () => ({ getSessionFromBearerToken: vi.fn() }));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => session),
}));
vi.mock('~/server/clickhouse/client', () => ({
  Tracker: class {
    retoolAudit = retoolAudit;
    userActivity = vi.fn();
  },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  reportCsamImages: mockReport,
}));

import handler from '~/pages/api/mod/image/report-csam';

function call(body: Record<string, unknown>) {
  const req = { method: 'POST', headers: {}, body, query: {} } as Parameters<typeof handler>[0];
  let statusCode = 200;
  const res = {
    status(c: number) {
      statusCode = c;
      return res;
    },
    json: () => res,
    setHeader: vi.fn(),
    end: () => res,
  } as unknown as Parameters<typeof handler>[1];
  return handler(req, res).then(() => statusCode);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockReport.mockResolvedValue(undefined);
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  redisMock.sysRedis.ttl.mockResolvedValue(60);
});

describe('image.reportCsam audit row', () => {
  // The moderator app's Scan Labels hold sweep calls this as a service actor; the audit row is the only
  // place the moderator whose vote asked for the hold is recorded against the report.
  it('records the Scan Labels voter id', async () => {
    expect(await call({ imageIds: [3], scanLabelVoterId: 11 })).toBe(200);
    expect(mockReport).toHaveBeenCalledWith(expect.objectContaining({ imageIds: [3] }));
    expect(retoolAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'image.reportCsam',
        outcome: 'ok',
        payload: { imageIds: [3], scanLabelVoterId: 11 },
        affected: { imageIds: [3] },
      })
    );
  });
});
