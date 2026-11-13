import { generateKeyPairSync } from 'node:crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setEnv } from '~/__tests__/mocks/env.mock';
import type * as AppAssistantService from '~/server/services/app-assistant/app-assistant.service';
import type * as AppBlocksFlag from '~/server/services/app-blocks-flag';
import type * as HibernationDepsModule from '~/server/services/app-hibernation/hibernation-deps';
import {
  sha,
  world,
  type World,
} from '~/server/services/app-hibernation/__tests__/hibernation.fakes';

/**
 * App hibernate for App Assistant's server runner: `/api/internal/app-assistant/sleeping-apps`
 * and `/wake-seed`, FOR the user the run grant names.
 *
 * The routes run with the REAL grant verification and the REAL sleeping-app service (on the
 * in-memory hibernation fakes); mocked are the user gates (`getRunnerDevTunnelUser`, covered in
 * app-assistant.service.test.ts) and the flag. Pinned: which user the list and the wake ticket are
 * for, that another user's app answers as no app does, and that the flag off answers `disabled`
 * having minted nothing.
 */

const m = vi.hoisted(() => ({
  runnerUser: vi.fn(),
  enabled: vi.fn(async (_opts: { user?: { id: number } | null }) => true),
  world: undefined as unknown as World,
}));

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/services/app-assistant/app-assistant.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AppAssistantService>()),
  getRunnerDevTunnelUser: m.runnerUser,
}));
vi.mock('~/server/services/app-blocks-flag', async (importOriginal) => ({
  ...(await importOriginal<typeof AppBlocksFlag>()),
  isAppHibernateEnabled: m.enabled,
}));
vi.mock('~/server/services/app-hibernation/hibernation-deps', async (importOriginal) => ({
  ...(await importOriginal<typeof HibernationDepsModule>()),
  defaultHibernationDeps: async () => m.world.deps,
}));

const { signRunGrant } = await import('~/server/services/app-assistant/assistant-runner-tokens');
const listRoute = (await import('~/pages/api/internal/app-assistant/sleeping-apps')).default;
const wakeRoute = (await import('~/pages/api/internal/app-assistant/wake-seed')).default;
const { beginHibernation, commitHibernation } = await import(
  '~/server/services/app-hibernation/app-hibernation.service'
);

// TEST-ONLY values: a key pair generated for this run and a placeholder secret.
const SECRET = 'test-only-runner-secret-for-sleeping-apps';
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const SIGNING_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

// Pairwise-distinct users, apps and archives.
const OWNER = 5301;
const OTHER = 5402;
const OWNED_APP = 'river-map';
const OTHERS_APP = 'quiz-night';
const ARCHIVE = Buffer.from('PK\x03\x04 river map');
const OTHERS_ARCHIVE = Buffer.from('PK\x03\x04 quiz night, a longer one');

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown> | unknown;

async function call(route: unknown, body: unknown, headers: Record<string, string> = asRunner) {
  let status = 200;
  let json: Record<string, unknown> | undefined;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(value: Record<string, unknown>) {
      json = value;
      return res;
    },
    setHeader() {
      return res;
    },
  } as unknown as NextApiResponse;
  await (route as Handler)(
    { method: 'POST', headers, body, query: {} } as unknown as NextApiRequest,
    res
  );
  return { status, json };
}

const asRunner = { authorization: `Bearer ${SECRET}` };
const grantFor = async (userId: number) =>
  (await signRunGrant({ userId, conversationId: `c-${userId}`, idempotencyKey: `k-${userId}` }))
    .token;

async function sleepApp(userId: number, app: string, archive: Buffer, attemptId: string) {
  const b = await beginHibernation({ userId, app, attemptId }, m.world.deps);
  if (b.kind !== 'ok') throw new Error(b.kind);
  m.world.objects.set(b.archive.key, archive);
  await commitHibernation(
    { attemptId, sha256: sha(archive), bytes: archive.length, excluded: [] },
    m.world.deps
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  setEnv({
    ASSISTANT_RUNNER_SECRET: SECRET,
    ASSISTANT_RUNNER_SIGNING_KEY: SIGNING_KEY,
    ASSISTANT_RUNNER_GRANT_TTL_SECONDS: 7800,
  });
  m.runnerUser.mockImplementation(async (userId: number) => ({
    refusal: null,
    user: { id: userId },
  }));
  m.enabled.mockResolvedValue(true);
  m.world = world();
  await sleepApp(OWNER, OWNED_APP, ARCHIVE, '31111111-1111-4111-8111-111111111111');
  await sleepApp(OTHER, OTHERS_APP, OTHERS_ARCHIVE, '32222222-2222-4222-8222-222222222222');
});

describe('POST /api/internal/app-assistant/sleeping-apps', () => {
  it('401 to a wrong secret or a forged grant', async () => {
    const grant = await grantFor(OWNER);
    expect((await call(listRoute, { grant }, { authorization: 'Bearer nope' })).status).toBe(401);
    expect(await call(listRoute, { grant: 'not-a-grant' })).toMatchObject({
      status: 401,
      json: { code: 'invalid_grant' },
    });
  });

  it('lists the grant’s user’s own sleeping apps only', async () => {
    const { status, json } = await call(listRoute, { grant: await grantFor(OWNER) });
    expect(status).toBe(200);
    expect(json).toEqual({
      apps: [expect.objectContaining({ app: OWNED_APP, bytes: ARCHIVE.length })],
    });
    expect(m.enabled).toHaveBeenCalledWith({ user: { id: OWNER } });
  });

  it('404 disabled with the flag off; a refused user gets the gate’s refusal', async () => {
    m.enabled.mockResolvedValue(false);
    expect(await call(listRoute, { grant: await grantFor(OWNER) })).toMatchObject({
      status: 404,
      json: { code: 'disabled' },
    });
    m.runnerUser.mockResolvedValue({
      refusal: { status: 403, error: 'App Assistant is off for you', code: 'refused' },
    });
    expect(await call(listRoute, { grant: await grantFor(OWNER) })).toMatchObject({
      status: 403,
      json: { code: 'refused' },
    });
  });
});

describe('POST /api/internal/app-assistant/wake-seed', () => {
  it('mints ONE ticket, for the grant’s user, app and archive', async () => {
    const { status, json } = await call(wakeRoute, {
      grant: await grantFor(OWNER),
      app: OWNED_APP,
    });
    expect(status).toBe(200);
    expect(json).toMatchObject({ app: OWNED_APP, sha256: sha(ARCHIVE), bytes: ARCHIVE.length });
    expect(typeof json?.ticket).toBe('string');
    expect([...m.world.ticketsMap.values()]).toEqual([
      { userId: OWNER, app: OWNED_APP, sha256: sha(ARCHIVE) },
    ]);
  });

  it('another user’s app answers as no app does, and mints nothing', async () => {
    expect(await call(wakeRoute, { grant: await grantFor(OWNER), app: OTHERS_APP })).toMatchObject({
      status: 404,
      json: { code: 'NOT_FOUND' },
    });
    expect(await call(wakeRoute, { grant: await grantFor(OWNER), app: 'none-such' })).toMatchObject(
      { status: 404, json: { code: 'NOT_FOUND' } }
    );
    expect(m.world.ticketsMap.size).toBe(0);
  });

  it('the flag off answers disabled and mints nothing; a non-slug key is a bad body', async () => {
    m.enabled.mockResolvedValue(false);
    expect(await call(wakeRoute, { grant: await grantFor(OWNER), app: OWNED_APP })).toMatchObject({
      status: 404,
      json: { code: 'disabled' },
    });
    m.enabled.mockResolvedValue(true);
    expect((await call(wakeRoute, { grant: await grantFor(OWNER), app: '../x' })).status).toBe(400);
    expect(m.world.ticketsMap.size).toBe(0);
  });
});
