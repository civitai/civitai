import { generateKeyPairSync } from 'node:crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import type * as FliptClient from '~/server/flipt/client';

/**
 * The runner's two platform-update routes, through their pages and the real front door
 * (`readRunnerRequest`, a real signed run grant): a preview grant is refused before anything is
 * read, and a failure behind the gate answers 503 `unavailable`. What the routes answer once past
 * the gate is `runner-platform-updates.test.ts`.
 */

const { isFlipt } = vi.hoisted(() => ({ isFlipt: vi.fn(async (_flag: string) => false) }));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt,
}));

const { signRunGrant } = await import('~/server/services/app-assistant/assistant-runner-tokens');
const listRoute = (await import('~/pages/api/internal/app-assistant/platform-updates')).default;
const resolveRoute = (await import('~/pages/api/internal/app-assistant/platform-updates/resolve'))
  .default;

// TEST-ONLY values: a key pair generated for this run, and a placeholder secret.
const SECRET = 'test-only-runner-secret';
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const SIGNING_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown> | unknown;

async function call(handler: Handler, body: Record<string, unknown>) {
  let status = 200;
  let json: unknown;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(value: unknown) {
      json = value;
      return res;
    },
    setHeader: () => res,
  } as unknown as NextApiResponse;
  const req = { method: 'POST', headers: { authorization: `Bearer ${SECRET}` }, body, query: {} };
  await handler(req as unknown as NextApiRequest, res);
  return { status, json };
}

const grantFor = async (use?: 'preview') =>
  (
    await signRunGrant({
      userId: 42,
      conversationId: use ? 'preview:my-shop' : 'c-1',
      idempotencyKey: 'k-1',
      ...(use ? { use } : {}),
    })
  ).token;

const listBody = (grant: string) => ({ grant, app: 'my-shop' });
const resolveBody = (grant: string) => ({
  grant,
  app: 'my-shop',
  id: 'apu_1',
  commitSha: 'a'.repeat(40),
  outcome: 'merged',
});

const routes = [
  ['platform-updates', listRoute, listBody],
  ['platform-updates/resolve', resolveRoute, resolveBody],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  isFlipt.mockResolvedValue(false);
  setEnv({
    ASSISTANT_RUNNER_SECRET: SECRET,
    ASSISTANT_RUNNER_SIGNING_KEY: SIGNING_KEY,
    ASSISTANT_RUNNER_GRANT_TTL_SECONDS: 7800,
  });
});

describe.each(routes)('POST /api/internal/app-assistant/%s', (_name, route, body) => {
  it('refuses a preview grant with 403 refused, reading nothing', async () => {
    isFlipt.mockResolvedValue(true);
    expect(await call(route, body(await grantFor('preview')))).toEqual({
      status: 403,
      json: { error: 'A preview grant cannot read platform updates', code: 'refused' },
    });
    expect(isFlipt).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.user.findUnique).not.toHaveBeenCalled();
  });

  it('CONTROL: the same body with a chat grant passes the front door and asks for the flag', async () => {
    const { status } = await call(route, body(await grantFor()));
    expect(status).not.toBe(403);
    expect(isFlipt).toHaveBeenCalled();
  });

  it('answers 503 unavailable when a read behind the gate fails', async () => {
    isFlipt.mockResolvedValue(true);
    dbMock.dbWrite.user.findUnique.mockRejectedValueOnce(new Error('connection reset'));
    expect(await call(route, body(await grantFor()))).toEqual({
      status: 503,
      json: { error: 'Could not read platform updates right now', code: 'unavailable' },
    });
  });
});
