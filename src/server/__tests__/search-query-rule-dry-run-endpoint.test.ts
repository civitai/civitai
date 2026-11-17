import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { BlocklistType } from '~/server/common/enums';
import type * as BlocklistService from '~/server/services/blocklist.service';
import type * as ClickhouseModule from '~/server/clickhouse/client';
import type * as ModeratorService from '~/server/services/moderator.service';

const { session, mockAudit, trackModActivity } = vi.hoisted(() => ({
  session: { current: null as null | { user: Record<string, unknown> } },
  mockAudit: vi.fn(),
  trackModActivity: vi.fn(),
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
vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlocklistService>()),
  stripBenignPhrases: async (text: string) => text,
}));
vi.mock('~/server/services/moderator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeratorService>()),
  trackModActivity,
}));

const { setQueryRuleReaderForTests } = await import('~/server/services/search-query-rules');
const handler = (await import('~/server/api-routes/mod/search-query-rule-dry-run')).default;

// Synthetic token: on no real list.
const POI = 'zqvoxpoitoken';

function call(method: string, body: Record<string, string>, query: Record<string, string> = {}) {
  const req = { method, query, headers: {}, body };
  let statusCode = 200;
  let payload: unknown;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(data: unknown) {
      payload = data;
      return res;
    },
    setHeader: vi.fn(),
    end: () => res,
  };
  return Promise.resolve(handler(req as never, res as never)).then(() => ({
    status: statusCode,
    body: payload as Record<string, unknown>,
  }));
}

const MOD = 990000321;
beforeEach(() => {
  vi.clearAllMocks();
  setQueryRuleReaderForTests({
    read: async (type) => ({
      terms: type === BlocklistType.SemanticSearchPoiRefuse ? [POI] : [],
      source: 'db',
    }),
  });
  session.current = { user: { id: MOD, isModerator: true, bannedAt: null, permissions: [] } };
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  redisMock.sysRedis.ttl.mockResolvedValue(60);
});

describe('/api/mod/search-query-rule-dry-run', () => {
  it('answers the verdict only, never the term, and records a ModActivity row', async () => {
    const { status, body } = await call('POST', { query: `photo of ${POI}` });

    expect(status).toBe(200);
    expect(body).toEqual({
      nonModerator: { verdict: 'poi', result: 'refuse' },
      moderator: { verdict: false, result: 'allow' },
    });
    expect(JSON.stringify(body)).not.toContain(POI);
    expect(trackModActivity).toHaveBeenCalledWith(MOD, {
      entityType: 'searchQueryRule',
      activity: 'dryRun',
    });
  });

  it('keeps the query out of the audit payload', async () => {
    await call('POST', { query: `photo of ${POI}` });

    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'searchQueryRules.dryRun', outcome: 'ok' })
    );
    expect(JSON.stringify(mockAudit.mock.calls)).not.toContain(POI);
  });

  it('refuses a query sent in the query string, which access logs keep', async () => {
    const { status } = await call('POST', {}, { query: `photo of ${POI}` });

    expect(status).toBe(400);
    expect(trackModActivity).not.toHaveBeenCalled();
  });

  it('refuses a non-moderator', async () => {
    session.current = { user: { id: 5, isModerator: false, bannedAt: null, permissions: [] } };

    const { status } = await call('POST', { query: `photo of ${POI}` });

    expect(status).toBe(403);
    expect(trackModActivity).not.toHaveBeenCalled();
  });
});
