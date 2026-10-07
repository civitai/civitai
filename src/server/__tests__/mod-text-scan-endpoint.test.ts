import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as ClickhouseModule from '~/server/clickhouse/client';
import type * as HarnessModule from '~/server/services/text-scan/harness';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const { session, mockAudit } = vi.hoisted(() => ({
  session: { current: null as null | { user: Record<string, unknown> } },
  mockAudit: vi.fn(),
}));

vi.mock('~/server/auth/bearer-token', () => ({ getSessionFromBearerToken: vi.fn() }));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => session.current),
}));
vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseModule>()),
  Tracker: class {
    retoolAudit = mockAudit;
  },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/services/text-scan/harness', async (importOriginal) => ({
  ...(await importOriginal<typeof HarnessModule>()),
  runTextScanHarnessAction: vi.fn(async () => ({ kind: 'json', body: { ok: true } })),
}));

const { default: handler, config, needsFullScope } = await import('~/pages/api/mod/text-scan');
const { runTextScanHarnessAction } = await import('~/server/services/text-scan/harness');
const { getSessionFromBearerToken } = await import('~/server/auth/bearer-token');

function call(
  body: unknown,
  query: Record<string, string> = {},
  headers: Record<string, string> = {}
) {
  const req = { method: 'POST', headers, query, body } as never;
  let statusCode = 200;
  let payload: unknown;
  const res = {
    status(c: number) {
      statusCode = c;
      return res;
    },
    json(b: unknown) {
      payload = b;
      return res;
    },
    setHeader: vi.fn(),
    end: () => res,
  };
  return Promise.resolve(handler(req, res as never)).then(() => ({
    status: statusCode,
    body: payload,
  }));
}

const MOD = 990000123;
beforeEach(() => {
  vi.clearAllMocks();
  session.current = { user: { id: MOD, isModerator: true, bannedAt: null, permissions: [] } };
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  redisMock.sysRedis.ttl.mockResolvedValue(60);
});

describe('mod/text-scan', () => {
  it('raises the body limit above a full request of texts', () => {
    expect(config.api.bodyParser.sizeLimit).toBe('4mb');
  });

  it('refuses a caller with no session, and a signed-in non-moderator, without reaching the harness', async () => {
    session.current = null;
    expect((await call({ action: 'getPrompts' })).status).toBe(401);
    session.current = { user: { id: 5, isModerator: false, bannedAt: null } };
    expect((await call({ action: 'getPrompts' })).status).toBe(403);
    expect(runTextScanHarnessAction).not.toHaveBeenCalled();
  });

  it('is not opened by the webhook token', async () => {
    session.current = null;
    expect((await call({ action: 'getPrompts' }, { token: 'test-webhook-token' })).status).toBe(
      401
    );
    expect(runTextScanHarnessAction).not.toHaveBeenCalled();
  });

  it('writes a prompt as the signed-in moderator, whatever id the body names', async () => {
    await call({
      action: 'putPrompt',
      key: 'base',
      content: 'BASE PROMPT',
      note: 'n',
      createdById: 1,
    });
    expect(runTextScanHarnessAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'putPrompt', createdById: 1 }),
      { moderatorId: MOD }
    );
  });

  it('sets a rollout as the signed-in moderator, shadow only unless allowActive is sent', async () => {
    await call({
      action: 'putModes',
      moderatorId: 1,
      entityType: 'Model',
      rollout: { shadow: 100 },
    });
    expect(runTextScanHarnessAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'putModes',
        rollout: { shadow: 100, active: 0 },
        allowActive: false,
      }),
      { moderatorId: MOD }
    );
  });

  it('writes config as the signed-in moderator', async () => {
    await call({ action: 'putConfig', moderatorId: 1, config: { thinking: true } });
    expect(runTextScanHarnessAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'putConfig' }),
      { moderatorId: MOD }
    );
  });

  it('keeps prompt text out of the audit row, including prompt overrides', async () => {
    await call({ action: 'putPrompt', key: 'base', content: 'BASE PROMPT', note: 'n' });
    await call({
      action: 'scanEntity',
      entityType: 'Post',
      entityId: 1,
      promptOverrides: { 'label:nsfw': 'CANDIDATE PROMPT' },
    });
    expect(mockAudit).toHaveBeenCalledTimes(2);
    const [first, second] = mockAudit.mock.calls.map(
      (c) => c[0].payload as Record<string, unknown>
    );
    expect(first).toMatchObject({ action: 'putPrompt', key: 'base', note: 'n' });
    expect(JSON.stringify(first)).not.toContain('BASE PROMPT');
    expect(second).toMatchObject({ action: 'scanEntity', entityId: 1 });
    expect(JSON.stringify(second)).not.toContain('CANDIDATE PROMPT');
  });

  it('keeps free text out of the audit row', async () => {
    await call({
      action: 'scanTexts',
      entityType: 'Comment',
      texts: [{ key: 'a', fields: [{ heading: 'Comment', text: 'USER TEXT' }] }],
      promptOverrides: { base: 'CANDIDATE PROMPT' },
    });
    const payload = mockAudit.mock.calls[0][0].payload as Record<string, unknown>;
    expect(payload).toMatchObject({ action: 'scanTexts', entityType: 'Comment' });
    expect(JSON.stringify(payload)).not.toContain('USER TEXT');
    expect(JSON.stringify(payload)).not.toContain('CANDIDATE PROMPT');
  });

  it.each(['scan', 'batch', 'whatif', 'fetch', 'constructor', undefined])(
    'refuses %s with a 400',
    async (action) => {
      expect((await call({ action })).status).toBe(400);
      expect(runTextScanHarnessAction).not.toHaveBeenCalled();
    }
  );

  it('returns a CSV result as { csv }', async () => {
    vi.mocked(runTextScanHarnessAction).mockResolvedValueOnce({ kind: 'csv', body: '"a","b"' });
    expect(
      (await call({ action: 'sampleShadow', entityType: 'Post', label: 'nsfw', format: 'csv' }))
        .body
    ).toEqual({ csv: '"a","b"' });
  });

  describe('actions that need full scope', () => {
    const MOD_USER = { id: MOD, isModerator: true, bannedAt: null, permissions: [] };
    const asApiKey = (tokenScope: number) => {
      vi.mocked(getSessionFromBearerToken).mockResolvedValueOnce({
        user: MOD_USER,
        tokenScope,
      } as never);
      return { authorization: 'Bearer key' };
    };
    const textActions = [
      { action: 'composeEntities', entityType: 'Post', entityIds: [1] },
      { action: 'sampleShadow', entityType: 'Post', label: 'nsfw' },
      { action: 'scanEntity', entityType: 'Post', entityId: 1 },
      { action: 'batchEntities', entityType: 'Post', entityIds: [1], wait: 30 },
      { action: 'putPrompt', key: 'base', content: 'BASE PROMPT', note: 'n' },
      { action: 'putConfig', config: { thinking: true } },
      { action: 'putModes', entityType: 'Post', rollout: { shadow: 100 } },
    ];

    it.each(textActions)('$action refuses a narrowly-scoped API key', async (body) => {
      const res = await call(body, {}, asApiKey(TokenScope.UserRead | TokenScope.ModelsRead));
      expect(res.status).toBe(403);
      expect(runTextScanHarnessAction).not.toHaveBeenCalled();
    });

    it.each(textActions)('$action serves a full-scope API key', async (body) => {
      expect((await call(body, {}, asApiKey(TokenScope.Full))).status).toBe(200);
      expect(runTextScanHarnessAction).toHaveBeenCalledTimes(1);
    });

    it.each(textActions)('$action serves a session', async (body) => {
      expect((await call(body)).status).toBe(200);
    });

    it.each([
      { action: 'getPrompts' },
      { action: 'quoteEntities', entityType: 'Post', entityIds: [1] },
      {
        action: 'scanTexts',
        entityType: 'Comment',
        texts: [{ key: 'a', fields: [{ heading: 'Comment', text: 'x' }] }],
      },
    ])('$action serves a narrowly-scoped API key', async (body) => {
      expect((await call(body, {}, asApiKey(TokenScope.UserRead))).status).toBe(200);
    });

    it('fails closed: an action not on the narrow-scope list, such as a new one, needs full scope', () => {
      expect(needsFullScope('someNewAction')).toBe(true);
      expect(needsFullScope('composeEntities')).toBe(true);
      expect(needsFullScope('putPrompt')).toBe(true);
      expect(needsFullScope('scanTexts')).toBe(false);
    });
  });
});
