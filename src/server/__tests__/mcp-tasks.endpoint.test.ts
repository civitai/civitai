import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BearerModule from '~/server/auth/bearer-token';
import type * as FlagModule from '~/server/services/app-blocks-flag';
import type * as McpModule from '~/server/services/task-router-mcp.service';
import { envMock } from '~/__tests__/mocks/env.mock';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const h = vi.hoisted(() => ({
  session: vi.fn(),
  taskFlag: vi.fn(async () => true),
  handle: vi.fn(async () => ({ jsonrpc: '2.0', id: 1, result: {} })),
}));

vi.mock('~/server/auth/bearer-token', async (importOriginal) => ({
  ...(await importOriginal<typeof BearerModule>()),
  getSessionFromBearerToken: (...a: unknown[]) => h.session(...a),
}));
vi.mock('~/server/services/app-blocks-flag', async (importOriginal) => ({
  ...(await importOriginal<typeof FlagModule>()),
  isAppBlocksTaskKindEnabled: (...a: unknown[]) => h.taskFlag(...(a as [])),
}));
vi.mock('~/server/services/task-router-mcp.service', async (importOriginal) => ({
  ...(await importOriginal<typeof McpModule>()),
  handleMcpMessage: (...a: unknown[]) => h.handle(...(a as [])),
}));

const handler = (await import('~/pages/api/v1/mcp/tasks')).default;

function makeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
    end() {
      return res;
    },
    setHeader() {
      return res;
    },
  };
  return res;
}
async function post(headers: Record<string, string> = { authorization: 'Bearer tok' }) {
  const res = makeRes();
  await handler(
    { method: 'POST', headers, body: { jsonrpc: '2.0', id: 1, method: 'ping' } } as never,
    res as never
  );
  return res;
}
const session = (tokenScope: number, subject = { type: 'oauth', id: 'client_ok' }) => ({
  user: { id: 42 },
  tokenScope,
  subject,
});

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockClear();
  h.session.mockImplementation(async () => session(TokenScope.AIServicesWrite));
  h.taskFlag.mockImplementation(async () => true);
  envMock.set({
    TASK_ROUTER_URL: 'https://router.internal.example.invalid',
    TASK_ROUTER_MCP_PARTY_KEY: 'mcp-key',
    TASK_ROUTER_CALLBACK_ORIGIN: 'https://task-router.example.invalid',
    TASK_ROUTER_MCP_ALLOWLIST: ['client:client_ok'],
  });
});
afterEach(() => envMock.reset());

describe('POST /api/v1/mcp/tasks', () => {
  it('handles the message for an allowlisted caller with the AI write scope', async () => {
    const res = await post();
    expect(res.statusCode).toBe(200);
    expect(h.handle).toHaveBeenCalledWith(
      expect.objectContaining({ partyId: 'civitai-mcp' }),
      expect.objectContaining({ userId: 42, token: 'tok' }),
      expect.anything()
    );
  });

  it('refuses a request without a bearer token, even with a session cookie', async () => {
    const res = await post({ cookie: 'civ-token=x' });
    expect(res.statusCode).toBe(401);
    expect(h.handle).not.toHaveBeenCalled();
  });

  it('refuses a token without the AI services write scope', async () => {
    h.session.mockImplementation(async () => session(TokenScope.UserRead));
    expect((await post()).statusCode).toBe(403);
    expect(h.handle).not.toHaveBeenCalled();
  });

  it('refuses a caller off the allowlist, or without the flag', async () => {
    h.session.mockImplementation(async () =>
      session(TokenScope.AIServicesWrite, { type: 'oauth', id: 'client_other' })
    );
    expect((await post()).statusCode).toBe(403);
    h.session.mockImplementation(async () => session(TokenScope.AIServicesWrite));
    h.taskFlag.mockImplementation(async () => false);
    expect((await post()).statusCode).toBe(403);
    expect(h.handle).not.toHaveBeenCalled();
  });

  it('is not served when the MCP party is not configured', async () => {
    envMock.set({ TASK_ROUTER_MCP_PARTY_KEY: undefined });
    expect((await post()).statusCode).toBe(404);
    expect(h.session).not.toHaveBeenCalled();
  });
});
