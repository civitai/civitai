import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JWK } from 'jose';
import { createLocalJWKSet } from 'jose';
import vectors from '~/server/services/blocks/__tests__/fixtures/task-router-tickets.json';
import type * as TaskRouterModule from '~/server/services/blocks/task-router.service';
import type * as WorkflowsModule from '~/server/services/orchestrator/workflows';
import type * as OwnerModule from '~/server/services/orchestrator/assert-workflow-owner';

/**
 * The MCP requester end to end, minus HTTP: the router's match is stubbed to hand back the
 * router repo's vector tickets, which are verified for real; the orchestrator is stubbed; the
 * per-user daily cap runs over an in-memory Redis.
 */

const h = vi.hoisted(() => ({
  matchTask: vi.fn(),
  findTasks: vi.fn(),
  reportTaskStarted: vi.fn(async () => undefined),
  submitWorkflow: vi.fn(),
  getWorkflow: vi.fn(),
  assertWorkflowOwner: vi.fn(async () => undefined),
}));

vi.mock('~/server/services/blocks/task-router.service', async (importOriginal) => ({
  ...(await importOriginal<typeof TaskRouterModule>()),
  matchTask: (...a: unknown[]) => h.matchTask(...a),
  findTasks: (...a: unknown[]) => h.findTasks(...a),
  reportTaskStarted: (...a: unknown[]) => h.reportTaskStarted(...(a as [])),
  taskRouterJwks: () => createLocalJWKSet(vectors.jwks as { keys: JWK[] }),
  taskRouterUserRef: () => vectors.user,
}));
vi.mock('~/server/services/orchestrator/workflows', async (importOriginal) => ({
  ...(await importOriginal<typeof WorkflowsModule>()),
  submitWorkflow: (...a: unknown[]) => h.submitWorkflow(...a),
  getWorkflow: (...a: unknown[]) => h.getWorkflow(...a),
}));
vi.mock('~/server/services/orchestrator/assert-workflow-owner', async (importOriginal) => ({
  ...(await importOriginal<typeof OwnerModule>()),
  assertWorkflowOwner: (...a: unknown[]) => h.assertWorkflowOwner(...(a as [])),
}));

import { redisMock } from '~/__tests__/mocks/redis.mock';
import type { TaskRouterConfig } from '~/server/services/blocks/task-router.service';
import type { McpCaller } from '~/server/services/task-router-mcp.service';
import { handleMcpMessage, isMcpCallerAllowed } from '~/server/services/task-router-mcp.service';
import { BLOCK_BUZZ_CAP_PER_DAY } from '~/shared/constants/block-scope.constants';

const store = new Map<string, string>();
function installRedis() {
  const r = redisMock.sysRedis;
  r.incrBy.mockImplementation(async (k: string, n: number) => {
    const v = Number(store.get(k) ?? 0) + n;
    store.set(k, String(v));
    return v;
  });
  r.decrBy.mockImplementation(async (k: string, n: number) => {
    const v = Number(store.get(k) ?? 0) - n;
    store.set(k, String(v));
    return v;
  });
  r.expire.mockImplementation(async () => true);
  r.ttl.mockImplementation(async () => 3600);
}
const dailySpent = () =>
  [...store.entries()]
    .filter(([k]) => k.includes('buzz-cap'))
    .reduce((sum, [, v]) => sum + Number(v), 0);

const config: TaskRouterConfig = {
  url: 'https://router.internal.example.invalid',
  partyKey: 'mcp-key',
  partyId: vectors.audience,
  callbackOrigin: vectors.callbackOrigin,
  appAllowlist: ['client:client_ok', 'user:7'],
};
const caller: McpCaller = {
  userId: 42,
  token: 'callers-own-token',
  subject: { type: 'oauth', id: 'client_ok' },
};
const TASK_ID = 'tsk_01JVECTOR00000000000000000';

function matchReturning(name: string) {
  const vector = vectors.cases.find((c) => c.name === name)!;
  vi.setSystemTime(new Date(vector.verifyAt));
  h.matchTask.mockImplementation(async () => ({
    ok: true,
    match: {
      status: 'matched',
      taskId: vector.sub ?? TASK_ID,
      resolvedAs: [
        {
          step: 's0',
          goal: 'image.edit@1',
          tier: 'standard',
          ability: 'orch.image.edit.nano-banana-2-lite',
          provider: 'civitai-orchestrator',
          via: 'sticky',
          assignment: { event: 'kept' },
        },
      ],
      quote: { amount: 8, currency: 'buzz' },
      ticket: vector.ticket,
    },
  }));
}

const call = (name: string, args: Record<string, unknown>) =>
  handleMcpMessage(config, caller, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  }) as Promise<{ result: { structuredContent: Record<string, unknown>; isError?: boolean } }>;

const RUN = {
  task: 'image.edit@1',
  input: { prompt: 'make it night', images: ['https://img.example/a.png'] },
  budget: { amount: 20 },
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  store.clear();
  installRedis();
  for (const fn of Object.values(h)) fn.mockClear();
  h.submitWorkflow.mockImplementation(async () => ({ id: '42-20261026', status: 'scheduled' }));
  h.getWorkflow.mockImplementation(async () => ({
    id: '42-20261026',
    status: 'succeeded',
    cost: { total: 8 },
    steps: [
      {
        $type: 'imageGen',
        output: { images: [{ url: 'https://out.example/1.png', available: true }] },
      },
    ],
  }));
  matchReturning('valid');
});
afterEach(() => vi.useRealTimers());

describe('MCP run_task', () => {
  it("submits the ticket with the caller's own token, under the daily cap, and returns the output", async () => {
    const { result } = await call('run_task', RUN);

    expect(result.isError).toBeUndefined();
    expect(h.submitWorkflow).toHaveBeenCalledTimes(1);
    const sent = h.submitWorkflow.mock.calls[0][0] as {
      token: string;
      body: { tags: string[]; externalId: string; allowMatureContent: boolean };
    };
    expect(sent.token).toBe('callers-own-token');
    expect(sent.body.tags).toEqual(['task-router-mcp', 'task:image.edit@1', `tr:${TASK_ID}`]);
    expect(sent.body.externalId).toBe(`trmcp-${TASK_ID}`);
    expect(sent.body.allowMatureContent).toBe(false);
    expect(h.assertWorkflowOwner).toHaveBeenCalledWith(
      expect.objectContaining({ id: '42-20261026' }),
      42,
      'callers-own-token'
    );
    expect(dailySpent()).toBe(8);
    expect(result.structuredContent).toMatchObject({
      status: 'succeeded',
      outputs: ['https://out.example/1.png'],
      taskId: TASK_ID,
    });
  });

  it('refuses once the per-user daily cap is spent, without submitting', async () => {
    await call('run_task', RUN);
    const [key] = [...store.keys()];
    store.set(key, String(BLOCK_BUZZ_CAP_PER_DAY));
    const { result } = await call('run_task', RUN);
    expect(result).toMatchObject({ isError: true, structuredContent: { code: 'daily_cap' } });
    expect(h.submitWorkflow).toHaveBeenCalledTimes(1);
    expect(Number(store.get(key))).toBe(BLOCK_BUZZ_CAP_PER_DAY);
  });

  it('refuses a tampered ticket before reserving or submitting', async () => {
    matchReturning('tampered_quote');
    const { result } = await call('run_task', RUN);
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { code: 'task-ticket-invalid' },
    });
    expect(h.submitWorkflow).not.toHaveBeenCalled();
    expect(dailySpent()).toBe(0);
  });

  it('refunds the reservation when the submit throws', async () => {
    h.submitWorkflow.mockImplementation(async () => {
      throw new Error('orchestrator down');
    });
    await expect(call('run_task', RUN)).rejects.toThrow('orchestrator down');
    expect(dailySpent()).toBe(0);
  });

  it('answers an off-menu ask with the demand id and closest tasks', async () => {
    h.matchTask.mockImplementation(async () => ({
      ok: true,
      notYet: { status: 'not_yet', demandId: 'dem_1', closest: [] },
    }));
    const { result } = await call('run_task', {
      description: 'vectorize this image as an SVG',
      input: { image: 'https://img.example/a.png' },
      budget: { amount: 20 },
    });
    expect(result.structuredContent).toMatchObject({
      status: 'not_yet',
      demandId: 'dem_1',
      closest: [],
    });
    expect(h.submitWorkflow).not.toHaveBeenCalled();
  });
});

describe('MCP protocol and gates', () => {
  it('lists the two tools', async () => {
    const reply = (await handleMcpMessage(config, caller, {
      jsonrpc: '2.0',
      id: 'a',
      method: 'tools/list',
    })) as { result: { tools: { name: string }[] } };
    expect(reply.result.tools.map((t) => t.name)).toEqual(['find_tasks', 'run_task']);
  });

  it('gives a notification no reply', async () => {
    await expect(
      handleMcpMessage(config, caller, { jsonrpc: '2.0', method: 'notifications/initialized' })
    ).resolves.toBeNull();
  });

  it('allows a caller only by its allowlisted OAuth client or user id', () => {
    expect(isMcpCallerAllowed(config, caller)).toBe(true);
    expect(isMcpCallerAllowed(config, { ...caller, subject: { type: 'oauth', id: 'other' } })).toBe(
      false
    );
    expect(
      isMcpCallerAllowed(config, { ...caller, userId: 7, subject: { type: 'apiKey', id: 1 } })
    ).toBe(true);
    // An API key's own id never matches a `client:` entry.
    expect(
      isMcpCallerAllowed(config, { ...caller, subject: { type: 'apiKey', id: 'client_ok' } })
    ).toBe(false);
  });
});
