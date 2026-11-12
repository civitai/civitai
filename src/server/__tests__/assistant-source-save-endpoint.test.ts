import { generateKeyPairSync } from 'node:crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setEnv } from '~/__tests__/mocks/env.mock';
import type * as AppAssistantService from '~/server/services/app-assistant/app-assistant.service';

/**
 * App Assistant's server runner asks civitai to commit the open app to its source repo FOR the
 * user its run grant names: `/api/internal/app-assistant/source-save`. REAL grant verification;
 * mocked are the user gates (covered in app-assistant.service.test.ts) and the save itself
 * (app-source-repo.service.test.ts). Pinned: which user the save runs as, the refusals, and that
 * every answer of the save maps to one status.
 */

const m = vi.hoisted(() => ({
  runnerUser: vi.fn(),
  save: vi.fn<(args: { userId: number; app: string }) => Promise<unknown>>(),
}));

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/services/app-assistant/app-assistant.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AppAssistantService>()),
  getRunnerDevTunnelUser: m.runnerUser,
}));
vi.mock('~/server/services/blocks/app-source-repo.service', () => ({
  saveAssistantSourceFromSandbox: m.save,
}));

const { signRunGrant } = await import('~/server/services/app-assistant/assistant-runner-tokens');
const route = (await import('~/pages/api/internal/app-assistant/source-save')).default;

// TEST-ONLY values: a key pair generated for this run and a placeholder secret.
const SECRET = 'test-only-runner-secret-for-source-save';
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const SIGNING_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const OWNER = 5301;

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown> | unknown;
const asRunner = { authorization: `Bearer ${SECRET}` };

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
  m.save.mockResolvedValue({
    kind: 'committed',
    sha: 'f'.repeat(40),
    branch: 'main',
    conflict: false,
  });
});

describe('POST /api/internal/app-assistant/source-save', () => {
  it('401 to a wrong secret or a forged grant, saving nothing', async () => {
    const grant = await grantFor(OWNER);
    expect((await call({ grant, app: 'my-app' }, { authorization: 'Bearer nope' })).status).toBe(
      401
    );
    expect(await call({ grant: 'not-a-grant', app: 'my-app' })).toMatchObject({
      status: 401,
      json: { code: 'invalid_grant' },
    });
    expect(m.save).not.toHaveBeenCalled();
  });

  it('saves as the grant’s user, and says where it landed', async () => {
    expect(await call({ grant: await grantFor(OWNER), app: 'my-app' })).toEqual({
      status: 200,
      json: { saved: true, sha: 'f'.repeat(40), branch: 'main', conflict: false },
    });
    expect(m.save).toHaveBeenCalledExactlyOnceWith({ userId: OWNER, app: 'my-app' });
  });

  it('a gate that refuses the user answers its own status, and saves nothing', async () => {
    m.runnerUser.mockResolvedValue({
      refusal: { status: 403, error: 'App Assistant is not available', code: 'refused' },
    });
    expect(await call({ grant: await grantFor(OWNER), app: 'my-app' })).toEqual({
      status: 403,
      json: { error: 'App Assistant is not available', code: 'refused' },
    });
    expect(m.save).not.toHaveBeenCalled();
  });

  it('every answer of the save maps to one status (someone else’s app reads as none at all)', async () => {
    const grant = await grantFor(OWNER);
    const cases: Array<[unknown, number, Record<string, unknown>]> = [
      [{ kind: 'unchanged' }, 200, { saved: false, reason: 'unchanged' }],
      [{ kind: 'not-running' }, 200, { saved: false, reason: 'not-running' }],
      [{ kind: 'unavailable' }, 200, { saved: false, reason: 'unavailable' }],
      [{ kind: 'busy' }, 409, { error: 'Another save of this app is running', code: 'busy' }],
      [{ kind: 'too-large', message: 'big' }, 413, { error: 'big', code: 'too-large' }],
      [{ kind: 'refused' }, 404, { error: 'No app of yours under that key', code: 'NOT_FOUND' }],
    ];
    for (const [result, status, json] of cases) {
      m.save.mockResolvedValueOnce(result);
      expect(await call({ grant, app: 'my-app' })).toEqual({ status, json });
    }
  });

  it('a save that throws is a retryable 503, never a crash', async () => {
    m.save.mockRejectedValue(new Error('git host down'));
    expect(await call({ grant: await grantFor(OWNER), app: 'my-app' })).toEqual({
      status: 503,
      json: { error: 'Could not save the app right now', code: 'unavailable' },
    });
  });
});
