import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

/**
 * The shared moderation account keeps its reserved username, and no other account can take it, whoever
 * edits identities. Ids are invented.
 */

const SHARED = 900;
const OTHER = 501;
const SQUATTER = 502;

const h = vi.hoisted(() => ({
  session: vi.fn(),
  update: vi.fn(async () => ({ updated: true })),
}));

vi.mock('~/server/auth/get-server-auth-session', () => ({ getServerAuthSession: h.session }));
vi.mock('~/server/auth/bearer-token', () => ({ getSessionFromBearerToken: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({
  Tracker: class {
    retoolAudit = vi.fn();
  },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/services/user.service', () => ({ forceUpdateUserIdentity: h.update }));

const handler = (await import('~/pages/api/mod/user/update-identity')).default;

function call(body: Record<string, unknown>) {
  const req = { method: 'POST', headers: {}, body, query: {} };
  let status = 200;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json: () => res,
    setHeader: () => undefined,
    end: () => res,
  };
  return (handler as (req: unknown, res: unknown) => Promise<unknown>)(req, res).then(() => status);
}

const LOOKALIKES = [
  'Civ1taiModeration',
  'Civitai_Moderation',
  'CivitaiModerat\u0456on',
  'Civitai\u200bModeration',
];

const usernames: Record<number, string> = {
  [SHARED]: 'CivitaiModeration',
  [OTHER]: 'someone',
  [SQUATTER]: 'civitaimoderation',
};

beforeEach(() => {
  vi.clearAllMocks();
  setEnv({ CIVITAI_MODERATION_USER_ID: SHARED });
  h.session.mockResolvedValue({
    user: { id: 7, isModerator: true, permissions: ['retoolUpdateIdentity'], bannedAt: null },
  });
  dbMock.dbWrite.user.findUnique.mockImplementation((async ({ where }: { where: { id: number } }) =>
    where.id in usernames
      ? { id: where.id, username: usernames[where.id] || null }
      : null) as never);
  redisMock.sysRedis.multi.mockImplementation((() => {
    const chain = { set: () => chain, incr: () => chain, exec: async () => ['OK', 1] };
    return chain;
  }) as never);
});

describe('POST /api/mod/user/update-identity and the reserved username', () => {
  it.each(['CivitaiModeration', 'civitaimoderation'])(
    'refuses giving another account the reserved name %s',
    async (username) => {
      expect(await call({ userId: OTHER, username })).toBe(400);
      expect(h.update).not.toHaveBeenCalled();
    }
  );

  it.each(LOOKALIKES)('refuses giving another account the lookalike %j', async (username) => {
    expect(await call({ userId: OTHER, username })).toBe(400);
    expect(h.update).not.toHaveBeenCalled();
  });

  it('refuses renaming the shared account to a lookalike of its name', async () => {
    expect(await call({ userId: SHARED, username: LOOKALIKES[0] })).toBe(400);
    expect(h.update).not.toHaveBeenCalled();
  });

  it('lets another account holding the name keep it through an email or name edit', async () => {
    expect(await call({ userId: SQUATTER, username: 'CivitaiModeration', name: 'Squat' })).toBe(
      200
    );
    expect(h.update).toHaveBeenCalledOnce();
  });

  it('refuses renaming the shared account away from the reserved name', async () => {
    expect(await call({ userId: SHARED, username: 'someone-new' })).toBe(400);
    expect(await call({ userId: SHARED, username: 'someone-new', name: 'Someone' })).toBe(400);
    expect(h.update).not.toHaveBeenCalled();
  });

  it('recognises the shared account by its id when its name was lost, and lets it be restored', async () => {
    usernames[SHARED] = '';
    try {
      expect(await call({ userId: SHARED, username: 'someone-new' })).toBe(400);
      expect(h.update).not.toHaveBeenCalled();
      expect(await call({ userId: SHARED, username: 'CivitaiModeration' })).toBe(200);
    } finally {
      usernames[SHARED] = 'CivitaiModeration';
    }
  });

  it('lets another account holding the name be renamed away while the id is configured', async () => {
    expect(await call({ userId: SQUATTER, username: 'someone-else' })).toBe(200);
  });

  it('recognises the shared account by its name when its id is not configured', async () => {
    setEnv({ CIVITAI_MODERATION_USER_ID: '' });
    expect(await call({ userId: SHARED, username: 'someone-new' })).toBe(400);
    expect(h.update).not.toHaveBeenCalled();
  });

  it('still renames an ordinary account, and edits the shared account without renaming it', async () => {
    expect(await call({ userId: OTHER, username: 'someone-new' })).toBe(200);
    expect(await call({ userId: SHARED, name: 'Civitai Moderation' })).toBe(200);
    expect(await call({ userId: SHARED, username: 'CivitaiModeration' })).toBe(200);
    expect(h.update).toHaveBeenCalledTimes(3);
  });
});
