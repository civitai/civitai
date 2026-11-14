import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as FullUserCredential from '~/server/auth/full-user-credential';

/**
 * The mint endpoint's audit row. The source card text is read to route the batch and must never be
 * stored: not in the audit payload, and not in `affected`, which is written to the same row.
 */

const { mockAudit, mockMint } = vi.hoisted(() => ({ mockAudit: vi.fn(), mockMint: vi.fn() }));

vi.mock('~/server/auth/bearer-token', () => ({ getSessionFromBearerToken: vi.fn() }));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => ({
    user: { id: 990000007, isModerator: true, permissions: ['csamReports'], bannedAt: null },
  })),
}));
vi.mock('~/server/auth/full-user-credential', async (importOriginal) => ({
  ...(await importOriginal<typeof FullUserCredential>()),
  isFullScopeSession: () => true,
}));
vi.mock('~/server/clickhouse/client', () => ({
  Tracker: class {
    retoolAudit = mockAudit;
    userActivity = vi.fn();
  },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/services/review-batch/review-batch.service', () => ({
  mintReviewBatch: mockMint,
}));

const { default: handler } = await import('~/pages/api/mod/review-batches');

const SECRET = 'words only the card holds';

function call(body: Record<string, unknown>) {
  const sent: { status?: number; body?: unknown } = {};
  const req = { method: 'POST', headers: {}, body, query: {} } as Parameters<typeof handler>[0];
  const res = {
    status: (s: number) => ((sent.status = s), res),
    json: (b: unknown) => ((sent.body = b), res),
    setHeader: vi.fn(),
    end: () => res,
  } as unknown as Parameters<typeof handler>[1];
  return Promise.resolve(handler(req, res)).then(() => sent);
}

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  mockMint.mockResolvedValue({ batchId: 'b'.repeat(22), tier: 'general', link: 'https://x/b' });
});

describe('POST /api/mod/review-batches', () => {
  it('audits the call without the card text or the suspect flag, in the payload or affected', async () => {
    const sent = await call({
      ids: [1, 2],
      viewer: 8,
      suspect: false,
      source: 'card-1',
      sourceText: [SECRET],
    });
    expect(sent.status).toBe(200);
    expect(mockMint).toHaveBeenCalledWith(
      expect.objectContaining({ sourceText: [SECRET] }),
      expect.anything()
    );
    expect(mockAudit).toHaveBeenCalledTimes(1);
    const row = mockAudit.mock.calls[0][0];
    expect(row.payload).toEqual({ ids: [1, 2], viewer: 8, source: 'card-1' });
    expect(JSON.stringify(row)).not.toContain(SECRET);
    expect(JSON.stringify(sent.body)).not.toContain(SECRET);
  });
});
