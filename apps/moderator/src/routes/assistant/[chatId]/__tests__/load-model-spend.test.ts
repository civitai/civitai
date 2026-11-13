import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What the chat page tells the moderator before they ask: which model the next question runs on, and
 * what today has cost at the CURRENT list prices, not the ones this release shipped with.
 */

const { listTurns, tokensTodayByModel, listPrices } = vi.hoisted(() => ({
  listTurns: vi.fn(),
  tokensTodayByModel: vi.fn(),
  listPrices: vi.fn(),
}));

vi.mock('$lib/server/assistant/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/assistant/store')>()),
  getChat: vi.fn(async () => ({ id: 7, title: 'c' })),
  hasRunningTurn: vi.fn(async () => false),
  listPlaybooks: vi.fn(async () => []),
  listTurns,
  tokensTodayByModel,
  tokensToday: vi.fn(async () => 0),
  usdToday: vi.fn(async () => 0.4),
}));
vi.mock('$lib/server/assistant/spend-cap', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/assistant/spend-cap')>()),
  capsFor: vi.fn(async () => [{ scope: 'role', subject: 'moderator:mod-high-access', usd: 3 }]),
}));
vi.mock('$lib/server/moderator-db', () => ({ getModeratorDb: () => ({}) }));
vi.mock('$lib/server/xguard-api', () => ({ openrouterKey: () => 'test-key' }));
vi.mock('$lib/server/assistant/openrouter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/assistant/openrouter')>()),
  listPrices,
}));
vi.mock('$lib/server/access', () => ({
  requiresGrant: (_: string, fn: unknown) => fn,
  canSeeAddresses: () => true,
}));
// `$lib/server/db` demands its replica URL at module scope; see routes/abuse/__tests__/load-status.test.ts.
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));

const { load } = await import('../+page.server');

const run = async () =>
  (await (load as unknown as (e: unknown) => Promise<unknown>)({
    params: { chatId: '7' },
    locals: { user: { id: 1, roles: ['moderator:mod-high-access'] } },
  })) as {
    model: string;
    spend: { usd: number };
    allowance: { spentUsd: number; capUsd: number };
  };

beforeEach(() => {
  listTurns.mockReset().mockResolvedValue([]);
  tokensTodayByModel.mockReset().mockResolvedValue([]);
  listPrices.mockReset().mockResolvedValue({});
});

describe('/assistant/[chatId] load', () => {
  it("prices today's spend at the current list prices it was handed", async () => {
    tokensTodayByModel.mockResolvedValue([
      { model: 'z-ai/glm-5.3-flash', promptTokens: 1_000_000, completionTokens: 0 },
    ]);
    listPrices.mockResolvedValue({ 'z-ai/glm-5.3-flash': { input: 9, output: 9 } });
    expect((await run()).spend.usd).toBeCloseTo(9, 10);
  });

  it("keeps the chat on its last turn's model, and falls back to the default for one no longer listed", async () => {
    listTurns.mockResolvedValue([{ model: 'z-ai/glm-5.3', sources: [] }]);
    expect((await run()).model).toBe('z-ai/glm-5.3');
    listTurns.mockResolvedValue([{ model: 'retired/model', sources: [] }]);
    expect((await run()).model).toBe('z-ai/glm-5.3-flash');
  });

  it("shows today's spend against the cap the moderator's roles give them", async () => {
    expect((await run()).allowance).toEqual({ spentUsd: 0.4, capUsd: 3 });
  });
});
