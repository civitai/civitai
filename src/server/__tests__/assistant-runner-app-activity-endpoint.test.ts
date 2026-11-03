import { generateKeyPairSync } from 'node:crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setEnv } from '~/__tests__/mocks/env.mock';
import type * as AppAssistantService from '~/server/services/app-assistant/app-assistant.service';

/**
 * App Assistant's server runner reads what the open app did FOR the user its run grant names:
 * `/api/internal/app-assistant/app-activity`.
 *
 * The route runs with the REAL grant verification and the REAL read (`readAppActivity`); mocked
 * are the user gates (`getRunnerDevTunnelUser`, covered in app-assistant.service.test.ts) and the
 * read's sources. What is pinned here: which user the read runs as, and that an app of anyone
 * else's answers exactly as an app that does not exist.
 */

const m = vi.hoisted(() => ({
  runnerUser: vi.fn(),
  resolve: vi.fn<(blockId: string, userId: number) => Promise<unknown>>(),
  invocations: vi.fn<(opts: Record<string, unknown>) => Promise<unknown>>(),
  token: vi.fn<(userId: number) => Promise<string>>(),
  workflows: vi.fn<(query: Record<string, unknown>) => Promise<unknown>>(),
  errors: vi.fn<(opts: { userId: number; blockId: string }) => Promise<unknown[]>>(),
}));

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/services/app-assistant/app-assistant.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AppAssistantService>()),
  getRunnerDevTunnelUser: m.runnerUser,
}));
vi.mock('~/server/services/block-registry.service', () => ({
  BlockRegistry: { resolveDevPageBlockForAuthor: m.resolve },
}));
vi.mock('~/server/services/blocks/user-app-surface.service', () => ({
  listMyScopeInvocations: m.invocations,
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({ getOrchestratorToken: m.token }));
vi.mock('~/server/services/orchestrator/workflows', () => ({ queryWorkflows: m.workflows }));
vi.mock('~/server/services/app-assistant/preview-errors.service', () => ({
  readPreviewErrors: m.errors,
}));

const { signRunGrant } = await import('~/server/services/app-assistant/assistant-runner-tokens');
const route = (await import('~/pages/api/internal/app-assistant/app-activity')).default;

// TEST-ONLY values: a key pair generated for this run and a placeholder secret.
const SECRET = 'test-only-runner-secret-for-activity';
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const SIGNING_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

// Pairwise-distinct users and apps.
const OWNER = 4301;
const OTHER = 4402;
const OWNED_APP = 'gamma-app';
const OTHERS_APP = 'delta-app';
const APPS: Record<number, string> = { [OWNER]: OWNED_APP, [OTHER]: OTHERS_APP };

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown> | unknown;

async function call(body: unknown, headers: Record<string, string> = asRunner) {
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
  await (route as unknown as Handler)(
    { method: 'POST', headers, body, query: {} } as unknown as NextApiRequest,
    res
  );
  return { status, json };
}

const asRunner = { authorization: `Bearer ${SECRET}` };
const grantFor = async (userId: number) =>
  (await signRunGrant({ userId, conversationId: `c-${userId}`, idempotencyKey: `k-${userId}` }))
    .token;

beforeEach(() => {
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
  // Each user's own dev app resolves for them only, as `resolveDevPageBlockForAuthor` does.
  m.resolve.mockImplementation(async (blockId, userId) =>
    APPS[userId] === blockId
      ? {
          appBlockId: `ephemeral-${blockId}`,
          appId: `ephemeral-${blockId}`,
          blockId,
          status: 'ephemeral',
        }
      : null
  );
  m.invocations.mockResolvedValue({ items: [], nextCursor: null });
  m.token.mockResolvedValue('orch-token');
  m.workflows.mockResolvedValue({ items: [], nextCursor: undefined });
  m.errors.mockResolvedValue([]);
});

describe('POST /api/internal/app-assistant/app-activity', () => {
  it('401 to a wrong secret or a forged grant, reading nothing', async () => {
    const grant = await grantFor(OWNER);
    expect((await call({ grant, app: OWNED_APP }, { authorization: 'Bearer nope' })).status).toBe(
      401
    );
    expect(await call({ grant: 'not-a-grant', app: OWNED_APP })).toMatchObject({
      status: 401,
      json: { code: 'invalid_grant' },
    });
    expect(m.resolve).not.toHaveBeenCalled();
  });

  it('reads the grant’s user’s own app, every part as that user', async () => {
    const { status, json } = await call({ grant: await grantFor(OWNER), app: OWNED_APP });
    expect(status).toBe(200);
    expect(json).toMatchObject({ app: OWNED_APP, items: [], omitted: 0, unavailable: [] });
    expect(m.resolve).toHaveBeenCalledWith(OWNED_APP, OWNER);
    expect(m.invocations).toHaveBeenCalledWith(
      expect.objectContaining({ userId: OWNER, syntheticAppId: `ephemeral-${OWNED_APP}` })
    );
    expect(m.token).toHaveBeenCalledWith(OWNER);
    expect(m.errors).toHaveBeenCalledWith({ userId: OWNER, blockId: OWNED_APP });
  });

  it('answers another user’s app exactly as an app that does not exist: 404, nothing read', async () => {
    const grant = await grantFor(OWNER);
    const foreign = await call({ grant, app: OTHERS_APP });
    const missing = await call({ grant, app: 'never-made' });
    expect(foreign).toEqual(missing);
    expect(foreign).toMatchObject({ status: 404, json: { code: 'NOT_FOUND' } });
    expect(m.invocations).not.toHaveBeenCalled();
    expect(m.token).not.toHaveBeenCalled();
    expect(m.errors).not.toHaveBeenCalled();
  });

  it('passes a gate refusal through and reads nothing', async () => {
    m.runnerUser.mockResolvedValueOnce({
      refusal: {
        status: 403,
        error: 'You do not have access to Apps authoring',
        code: 'FORBIDDEN',
      },
    });
    expect(await call({ grant: await grantFor(OWNER), app: OWNED_APP })).toEqual({
      status: 403,
      json: { error: 'You do not have access to Apps authoring', code: 'FORBIDDEN' },
    });
    expect(m.resolve).not.toHaveBeenCalled();
  });

  it('a read that throws is 503 unavailable, with none of its text', async () => {
    m.resolve.mockRejectedValueOnce(new Error('read failed: socket closed (secret detail)'));
    expect(await call({ grant: await grantFor(OWNER), app: OWNED_APP })).toEqual({
      status: 503,
      json: { error: 'Could not read the app’s activity right now', code: 'unavailable' },
    });
  });
});
