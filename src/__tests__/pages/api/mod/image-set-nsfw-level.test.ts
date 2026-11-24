import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as ImageService from '~/server/services/image.service';

const { mockSetLevel, session } = vi.hoisted(() => ({
  mockSetLevel: vi.fn(),
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
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  updateImageNsfwLevel: mockSetLevel,
}));

import handler from '~/server/api-routes/mod/image/set-nsfw-level';

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
  mockSetLevel.mockResolvedValue(4);
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  redisMock.sysRedis.ttl.mockResolvedValue(60);
});

describe('image.setNsfwLevel', () => {
  // The in-game Inquisitor rules through here; left Pending, its image's rating requests come back
  // to the moderators' rating queue once the level is unlocked.
  it('settles the rating requests with the status the caller sends', async () => {
    expect(await call({ items: [{ imageId: 12, nsfwLevel: 4 }], status: 'Actioned' })).toBe(200);
    expect(mockSetLevel).toHaveBeenCalledWith({
      id: 12,
      nsfwLevel: 4,
      userId: 7,
      isModerator: true,
      status: 'Actioned',
    });
  });

  it('leaves the rating requests alone when no status is sent, as before', async () => {
    expect(await call({ items: [{ imageId: 12, nsfwLevel: 4 }] })).toBe(200);
    expect(mockSetLevel).toHaveBeenCalledWith({
      id: 12,
      nsfwLevel: 4,
      userId: 7,
      isModerator: true,
    });
  });
});
