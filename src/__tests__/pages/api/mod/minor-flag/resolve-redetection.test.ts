import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RESOLUTION_NOTE_MAX_LENGTH } from '@civitai/shared/resolution-reasons';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const { mockResolve, session } = vi.hoisted(() => ({
  mockResolve: vi.fn(),
  session: { user: { id: 7, isModerator: true, permissions: [], bannedAt: null } },
}));

vi.mock('~/server/auth/bearer-token', () => ({ getSessionFromBearerToken: vi.fn() }));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => session),
}));
vi.mock('~/server/clickhouse/client', () => ({
  Tracker: class {
    retoolAudit = vi.fn();
    userActivity = vi.fn();
  },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/services/text-scan/actions/redetection', () => ({
  resolveTextScanRedetection: mockResolve,
}));

import handler from '~/pages/api/mod/minor-flag/resolve-redetection';

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
  mockResolve.mockResolvedValue('kept');
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  redisMock.sysRedis.ttl.mockResolvedValue(60);
});

describe('minorFlag.resolveRedetection', () => {
  it('rules as the acting moderator', async () => {
    expect(await call({ modelId: 42, label: 'minor', keep: true, textHash: 'h-1' })).toBe(200);
    expect(mockResolve).toHaveBeenCalledWith({
      modelId: 42,
      label: 'minor',
      keep: true,
      textHash: 'h-1',
      userId: 7,
    });
  });

  it('passes a dismissal through as keep: false', async () => {
    await call({ modelId: 42, label: 'poi', keep: 'false', textHash: 'h-1' });
    expect(mockResolve).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'poi', keep: false })
    );
  });

  it('forwards a reason that belongs to the verdict, with its note', async () => {
    const body = { modelId: 42, label: 'minor', textHash: 'h-1' };
    await call({ ...body, keep: 'false', resolvedReason: 'other', internalNotes: 'a cartoon' });
    expect(mockResolve).toHaveBeenCalledWith(
      expect.objectContaining({ keep: false, reason: 'other', note: 'a cartoon' })
    );
  });

  it.each([
    ['a keep reason on a dismissal', { keep: false, resolvedReason: 'detection-correct' }],
    ['an appeal reason on a keep', { keep: true, resolvedReason: 'flag-confirmed' }],
    ['Other without a note', { keep: true, resolvedReason: 'other' }],
    [
      'a real-person reason on a minor detection',
      { keep: false, resolvedReason: 'not-a-real-person' },
    ],
    [
      'a note over the limit',
      {
        keep: true,
        resolvedReason: 'other',
        internalNotes: 'x'.repeat(RESOLUTION_NOTE_MAX_LENGTH + 1),
      },
    ],
  ])('refuses %s before resolving anything', async (_, ruling) => {
    expect(await call({ modelId: 42, label: 'minor', textHash: 'h-1', ...ruling })).toBe(400);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('rules without a reason when none is sent', async () => {
    await call({ modelId: 42, label: 'minor', keep: true, textHash: 'h-1' });
    expect(mockResolve.mock.calls[0][0].reason).toBeUndefined();
  });

  it('rejects an unknown label before resolving anything', async () => {
    expect(await call({ modelId: 42, label: 'nsfw', keep: true, textHash: 'h-1' })).toBe(400);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('rejects a ruling that does not name the text it was made on', async () => {
    expect(await call({ modelId: 42, label: 'minor', keep: true })).toBe(400);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('answers a refusal from the service with a client error, not a 500', async () => {
    mockResolve.mockRejectedValue(
      new TRPCError({ code: 'BAD_REQUEST', message: 'being resolved' })
    );
    const status = await call({ modelId: 42, label: 'minor', keep: true, textHash: 'h-1' });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
  });
});
