import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
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

const { default: handler, config } = await import('~/pages/api/mod/text-scan');
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
  session.current = {
    user: { id: MOD, isModerator: true, bannedAt: null, permissions: ['textScanPromptPublish'] },
  };
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

  it('refuses putPrompt to a moderator without the publish permission, reaching no harness', async () => {
    session.current = { user: { id: MOD, isModerator: true, bannedAt: null, permissions: [] } };
    const res = await call({ action: 'putPrompt', key: 'base', content: 'BASE PROMPT', note: 'n' });
    expect(res.status).toBe(403);
    expect(runTextScanHarnessAction).not.toHaveBeenCalled();
  });

  it.each([
    ['putConfig', { action: 'putConfig', config: { thinking: true } }],
    ['putModes', { action: 'putModes', entityType: 'Model', rollout: { shadow: 100 } }],
    [
      'putWebSearchModes',
      { action: 'putWebSearchModes', entityType: 'Model', rollout: { shadow: 10 } },
    ],
    ['putLabelModes', { action: 'putLabelModes', label: 'poi', mode: 'review' }],
  ])(
    'refuses %s to a moderator without the publish permission, reaching no harness',
    async (_, body) => {
      session.current = { user: { id: MOD, isModerator: true, bannedAt: null, permissions: [] } };
      const res = await call(body);
      expect(res.status).toBe(403);
      expect(runTextScanHarnessAction).not.toHaveBeenCalled();
    }
  );

  it('serves other actions to a moderator without the publish permission (control)', async () => {
    session.current = { user: { id: MOD, isModerator: true, bannedAt: null, permissions: [] } };
    expect((await call({ action: 'getPrompts' })).status).toBe(200);
    expect(runTextScanHarnessAction).toHaveBeenCalledTimes(1);
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

  it('sets the web-search rollout as the signed-in moderator, shadow only unless allowActive is sent', async () => {
    await call({
      action: 'putWebSearchModes',
      moderatorId: 1,
      entityType: 'Model',
      rollout: { shadow: 10 },
    });
    expect(runTextScanHarnessAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'putWebSearchModes',
        entityType: 'Model',
        rollout: { shadow: 10, active: 0 },
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
      entityType: 'CommentV3',
      texts: [{ key: 'a', fields: [{ heading: 'Comment', text: 'USER TEXT' }] }],
      promptOverrides: { base: 'CANDIDATE PROMPT' },
    });
    const payload = mockAudit.mock.calls[0][0].payload as Record<string, unknown>;
    expect(payload).toMatchObject({ action: 'scanTexts', entityType: 'CommentV3' });
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

  describe('API keys', () => {
    const MOD_USER = {
      id: MOD,
      isModerator: true,
      bannedAt: null,
      permissions: ['textScanPromptPublish'],
    };
    const asApiKey = (tokenScope: bigint) => {
      vi.mocked(getSessionFromBearerToken).mockResolvedValueOnce({
        user: MOD_USER,
        apiKeyId: 1,
        apiKeyType: 'User',
        subject: { type: 'apiKey', id: 1 },
        tokenScope,
      } as never);
      return { authorization: 'Bearer key' };
    };
    const actions = [
      { action: 'composeEntities', entityType: 'Post', entityIds: [1] },
      { action: 'sampleShadow', entityType: 'Post', label: 'nsfw' },
      { action: 'scanEntity', entityType: 'Post', entityId: 1 },
      { action: 'batchEntities', entityType: 'Post', entityIds: [1], wait: 30 },
      { action: 'putPrompt', key: 'base', content: 'BASE PROMPT', note: 'n' },
      { action: 'putConfig', config: { thinking: true } },
      { action: 'putModes', entityType: 'Post', rollout: { shadow: 100 } },
      { action: 'putWebSearchModes', entityType: 'Model', rollout: { shadow: 10 } },
      { action: 'getPrompts' },
      { action: 'quoteEntities', entityType: 'Post', entityIds: [1] },
      {
        action: 'scanTexts',
        entityType: 'CommentV3',
        texts: [{ key: 'a', fields: [{ heading: 'Comment', text: 'x' }] }],
      },
    ];

    it.each(actions)('$action refuses a reduced-scope personal API key', async (body) => {
      const res = await call(body, {}, asApiKey(TokenScope.UserRead | TokenScope.ModelsRead));
      expect(res.status).toBe(403);
      expect(runTextScanHarnessAction).not.toHaveBeenCalled();
    });

    it.each(actions)('$action serves a full-scope personal API key', async (body) => {
      expect((await call(body, {}, asApiKey(TokenScope.Full))).status).toBe(200);
      expect(runTextScanHarnessAction).toHaveBeenCalledTimes(1);
    });

    it.each(actions)('$action serves a session', async (body) => {
      expect((await call(body)).status).toBe(200);
    });
  });

  describe('putPrompt for the intent key', () => {
    const INTENT = 'label:model-com-face-intent';
    const rows = [
      { id: 77, content: 'V77', note: null, createdById: 1 },
      { id: 90, content: 'BY A MODERATOR', note: null, createdById: MOD },
      { id: 100, content: 'BAD', note: 'holder-revokes:111', createdById: 1 },
      { id: 111, content: 'V111', note: null, createdById: 1 },
      { id: 112, content: 'V112', note: 'restore 111 holder-revokes:100', createdById: 1 },
    ];
    const as = (permissions: string[]) => {
      session.current = { user: { id: MOD, isModerator: true, bannedAt: null, permissions } };
    };
    const put = (content: string, key = INTENT) =>
      call({ action: 'putPrompt', key, content, note: 'n' });

    beforeEach(() => {
      dbMock.dbWrite.textScanPrompt.findMany.mockResolvedValue(rows);
      redisMock.sysRedis.get.mockResolvedValue(
        JSON.stringify({ textScanPromptPublish: [1, MOD], textScanPromptPublishIntent: [1] })
      );
    });

    it('refuses new text without the per-key grant, reaching no harness', async () => {
      as(['textScanPromptPublish']);
      expect((await put('NEW TEXT')).status).toBe(403);
      expect(runTextScanHarnessAction).not.toHaveBeenCalled();
    });

    it('publishes new text with the per-key grant', async () => {
      as(['textScanPromptPublish', 'textScanPromptPublishIntent']);
      expect((await put('NEW TEXT')).status).toBe(200);
      expect(runTextScanHarnessAction).toHaveBeenCalledTimes(1);
    });

    it('leaves another key to the publish permission alone', async () => {
      as(['textScanPromptPublish']);
      expect((await put('NEW TEXT', 'label:nsfw')).status).toBe(200);
      expect(runTextScanHarnessAction).toHaveBeenCalledTimes(1);
    });

    it.each(['V111', 'V77', 'V112'])(
      'restores %s, an unrevoked version by a holder, with the publish permission alone',
      async (content) => {
        as(['textScanPromptPublish']);
        expect((await put(content)).status).toBe(200);
        expect(runTextScanHarnessAction).toHaveBeenCalledTimes(1);
      }
    );

    it.each([
      ['one changed byte', 'V111 '],
      ['a version by a non-holder', 'BY A MODERATOR'],
      ['a version a later note revokes', 'BAD'],
    ])('refuses %s without the per-key grant', async (_, content) => {
      as(['textScanPromptPublish']);
      expect((await put(content)).status).toBe(403);
      expect(runTextScanHarnessAction).not.toHaveBeenCalled();
    });

    it("ignores a revoking note by a non-holder's restore", async () => {
      dbMock.dbWrite.textScanPrompt.findMany.mockResolvedValue([
        ...rows,
        { id: 113, content: 'V77', note: 'restore revokes:111', createdById: MOD },
      ]);
      as(['textScanPromptPublish']);
      expect((await put('V111')).status).toBe(200);
    });

    it('keeps a version revoked after the revoking holder loses the grant', async () => {
      // 115 was written by a holder (stamped at write) who no longer holds the grant.
      dbMock.dbWrite.textScanPrompt.findMany.mockResolvedValue([
        { id: 77, content: 'V77', note: null, createdById: 1 },
        { id: 115, content: 'V77', note: 'restore 77 holder-revokes:111', createdById: 2 },
        { id: 111, content: 'V111', note: null, createdById: 1 },
      ]);
      as(['textScanPromptPublish']);
      expect((await put('V111')).status).toBe(403);
    });

    it('retires every earlier copy of the revoked text, not only the id named', async () => {
      dbMock.dbWrite.textScanPrompt.findMany.mockResolvedValue([
        { id: 120, content: 'DUP', note: null, createdById: 1 },
        { id: 121, content: 'DUP', note: 'reverted', createdById: 1 },
        { id: 122, content: 'V122', note: 'holder-revokes:121', createdById: 1 },
      ]);
      as(['textScanPromptPublish']);
      expect((await put('DUP')).status).toBe(403);
    });

    it("lifts a revocation with a current holder's explicit restore", async () => {
      dbMock.dbWrite.textScanPrompt.findMany.mockResolvedValue([
        ...rows,
        { id: 116, content: 'BAD', note: 'reinstate 100', createdById: 1 },
      ]);
      as(['textScanPromptPublish']);
      expect((await put('BAD')).status).toBe(200);
    });

    const putNote = (note: string) =>
      call({ action: 'putPrompt', key: INTENT, content: 'V111', note });
    const savedNote = () =>
      (vi.mocked(runTextScanHarnessAction).mock.calls[0][0] as { note?: string }).note;

    it("stamps a holder's revokes note at write time", async () => {
      as(['textScanPromptPublish', 'textScanPromptPublishIntent']);
      await putNote('restore 111 revokes:100');
      expect(savedNote()).toBe('restore 111 holder-revokes:100');
    });

    it("never stamps a non-holder's note, and strips a stamp it supplies", async () => {
      as(['textScanPromptPublish']);
      await putNote('restore 111 revokes:100 Holder-Revokes:77');
      expect(savedNote()).toBe('restore 111 revokes:100 revokes:77');
    });

    it.each([
      'holder-holder-revokes:5',
      'holder-holder-holder-revokes:5',
      'HOLDER-holder-revokes:5',
    ])('never lets a non-holder forge a stamp from %s', async (note) => {
      as(['textScanPromptPublish']);
      await putNote(note);
      expect(savedNote()).not.toMatch(/holder-revokes:/i);
    });

    it('refuses a restore once its author no longer holds the per-key grant', async () => {
      redisMock.sysRedis.get.mockResolvedValue(JSON.stringify({ textScanPromptPublishIntent: [] }));
      as(['textScanPromptPublish']);
      expect((await put('V111')).status).toBe(403);
    });
  });
});
