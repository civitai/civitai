import { generateKeyPairSync } from 'node:crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setEnv } from '~/__tests__/mocks/env.mock';
import type * as FliptClient from '~/server/flipt/client';

/**
 * App Assistant's server runner reports each finished turn: `/api/internal/app-assistant/turn`.
 *
 * The route runs with the REAL grant verification and the REAL `recordAssistantTurn`; mocked are
 * the process boundaries it writes through (Flipt, Postgres's raw upsert, ClickHouse's insert).
 * What is pinned here: who may report, that the user and chat come from the grant and never the
 * body, that the flag off writes nothing, and that a failing write never fails the report.
 */

const m = vi.hoisted(() => ({
  tracingOn: { value: true },
  executeRaw: vi.fn<(strings: TemplateStringsArray, ...values: unknown[]) => Promise<number>>(),
  insert: vi.fn<(args: { table: string; values: unknown[]; format: string }) => Promise<void>>(),
}));

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn(), safeError: (e: unknown) => e }));
// Flipt is a process boundary: only the tracing flag is answered here; every other key is off.
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(async (flag: string) => flag === 'app-assistant-tracing' && m.tracingOn.value),
}));
vi.mock('~/server/db/client', () => ({ dbWrite: { $executeRaw: m.executeRaw } }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: { insert: m.insert } }));

const { signRunGrant } = await import('~/server/services/app-assistant/assistant-runner-tokens');
const route = (await import('~/pages/api/internal/app-assistant/turn')).default;

// TEST-ONLY values: a key pair generated for this run and a placeholder secret.
const SECRET = 'test-only-runner-secret-for-turns';
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const SIGNING_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

// Pairwise-distinct users, chats, apps, numbers and times.
const USER = 6107;
const CONVERSATION = 'conv-from-grant-8842';
const APP = 'theme-probe-app';

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
const grantFor = async (use?: 'preview') =>
  (
    await signRunGrant({
      userId: USER,
      conversationId: CONVERSATION,
      idempotencyKey: 'key-3391',
      ...(use ? { use } : {}),
    })
  ).token;

const report = (grant: string, overrides: Record<string, unknown> = {}) => ({
  v: 1,
  grant,
  app: APP,
  seq: 4,
  runId: 'run-5530',
  model: 'model-x9',
  status: 'done',
  buzz: 17.5,
  toolCalls: { read_docs: 2, sandbox__write_file: 9 },
  durationMs: 61_250,
  startedAt: '2026-11-21T08:00:00.000Z',
  endedAt: '2026-11-21T08:01:01.250Z',
  ...overrides,
});

/** The values the upsert's tagged template was given, in order. */
const upsertValues = () => m.executeRaw.mock.calls[0]!.slice(1);

beforeEach(() => {
  vi.clearAllMocks();
  m.tracingOn.value = true;
  setEnv({
    ASSISTANT_RUNNER_SECRET: SECRET,
    ASSISTANT_RUNNER_SIGNING_KEY: SIGNING_KEY,
    ASSISTANT_RUNNER_GRANT_TTL_SECONDS: 7800,
  });
  m.executeRaw.mockResolvedValue(1);
  m.insert.mockResolvedValue(undefined);
});

describe('POST /api/internal/app-assistant/turn', () => {
  it('401 to a wrong secret or a forged grant, writing nothing', async () => {
    const grant = await grantFor();
    expect((await call(report(grant), { authorization: 'Bearer nope' })).status).toBe(401);
    expect(await call(report('not-a-grant'))).toMatchObject({
      status: 401,
      json: { code: 'invalid_grant' },
    });
    expect(m.executeRaw).not.toHaveBeenCalled();
    expect(m.insert).not.toHaveBeenCalled();
  });

  it('403 to a preview grant, which runs no reply, writing nothing', async () => {
    expect(await call(report(await grantFor('preview')))).toMatchObject({
      status: 403,
      json: { code: 'refused' },
    });
    expect(m.executeRaw).not.toHaveBeenCalled();
    expect(m.insert).not.toHaveBeenCalled();
  });

  it('400 to a body that is not a turn report', async () => {
    const grant = await grantFor();
    expect((await call(report(grant, { status: 'exploded' }))).status).toBe(400);
    expect((await call(report(grant, { buzz: -1 }))).status).toBe(400);
    expect(await call({ grant })).toMatchObject({ status: 400 });
    expect(m.insert).not.toHaveBeenCalled();
  });

  it('with the flag off answers 200 and writes nothing at all', async () => {
    m.tracingOn.value = false;
    expect(await call(report(await grantFor()))).toEqual({
      status: 200,
      json: { tracing: false, linked: false, event: false },
    });
    expect(m.executeRaw).not.toHaveBeenCalled();
    expect(m.insert).not.toHaveBeenCalled();
  });

  it('with the flag on upserts the link for the grant’s user and chat, and emits one turn row', async () => {
    expect(await call(report(await grantFor()))).toEqual({
      status: 200,
      json: { tracing: true, linked: true, event: true },
    });
    expect(m.executeRaw).toHaveBeenCalledTimes(1);
    expect(upsertValues()).toEqual([
      USER,
      CONVERSATION,
      APP,
      new Date('2026-11-21T08:00:00.000Z'),
      new Date('2026-11-21T08:01:01.250Z'),
      'model-x9',
      17.5,
      'run-5530',
      4,
    ]);
    expect(m.insert).toHaveBeenCalledTimes(1);
    expect(m.insert.mock.calls[0]![0]).toEqual({
      table: 'appAssistantTurns',
      format: 'JSONEachRow',
      values: [
        {
          time: '2026-11-21 08:01:01.250',
          startedAt: '2026-11-21 08:00:00.000',
          userId: USER,
          conversationId: CONVERSATION,
          appSlug: APP,
          seq: 4,
          runId: 'run-5530',
          model: 'model-x9',
          status: 'done',
          buzz: 17.5,
          durationMs: 61_250,
          toolCallCount: 11,
          toolCalls: { read_docs: 2, sandbox__write_file: 9 },
        },
      ],
    });
  });

  it('takes the user and chat from the grant even when the body names others', async () => {
    await call(report(await grantFor(), { userId: 1, conversationId: 'someone-elses' }));
    expect(upsertValues().slice(0, 2)).toEqual([USER, CONVERSATION]);
    expect(m.insert.mock.calls[0]![0].values[0]).toMatchObject({
      userId: USER,
      conversationId: CONVERSATION,
    });
  });

  it('a turn with no app chosen writes no link, and still emits its turn row', async () => {
    expect(await call(report(await grantFor(), { app: null }))).toEqual({
      status: 200,
      json: { tracing: true, linked: false, event: true },
    });
    expect(m.executeRaw).not.toHaveBeenCalled();
    expect(m.insert.mock.calls[0]![0].values[0]).toMatchObject({ appSlug: '' });
  });

  it('a link write that fails (the table not applied yet) and a ClickHouse insert that fails still answer 200', async () => {
    m.executeRaw.mockRejectedValueOnce(
      new Error('relation "app_assistant_session_links" does not exist')
    );
    m.insert.mockRejectedValueOnce(new Error('Table default.appAssistantTurns does not exist'));
    expect(await call(report(await grantFor()))).toEqual({
      status: 200,
      json: { tracing: true, linked: false, event: false },
    });
  });
});
