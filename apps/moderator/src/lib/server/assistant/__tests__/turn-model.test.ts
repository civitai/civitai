import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The model a moderator picks is the one the turn is recorded with AND the one the model call goes
 * to. Either alone would let the audit name a model that never ran, or run one nobody chose.
 */

const { complete, startTurn, finishTurn, listPrices } = vi.hoisted(() => ({
  complete: vi.fn(),
  startTurn: vi.fn(),
  finishTurn: vi.fn(),
  listPrices: vi.fn(),
}));

// The real model resolution; only the network call is faked.
vi.mock('../../xguard-api', () => ({ openrouterKey: () => 'test-key' }));
vi.mock('../openrouter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../openrouter')>()),
  complete,
  listPrices,
}));
vi.mock('../tools', () => ({ LOOKUP: '/lookup', toolSpec: () => ({}), toolsFor: () => [] }));
vi.mock('../store', () => ({
  DEFAULT_CHAT_TITLE: 'New chat',
  getChat: vi.fn(async () => ({ title: 'c', seedUserId: null, seedReportId: null })),
  listTurns: vi.fn(async () => []),
  listPlaybooks: vi.fn(async () => []),
  getPlaybook: vi.fn(async () => null),
  getMaskSalt: vi.fn(async () => 'salt'),
  startTurn,
  finishTurn,
  renameChat: vi.fn(async () => true),
  hasRunningTurn: vi.fn(async () => false),
  tokensToday: vi.fn(async () => 0),
}));

const { executeTurn } = await import('../turn.service');

const ask = (model: string | null, allowance = { spentUsd: 0, capUsd: 1, usedTokens: 0 }) =>
  executeTurn({
    chatId: 1,
    moderator: { id: 1, username: 'mod' },
    prompt: 'q',
    playbookSlug: null,
    model,
    canAccess: () => true,
    hasGrant: () => true,
    allowance,
    emit: () => {},
  });

beforeEach(() => {
  startTurn.mockReset().mockResolvedValue(9);
  finishTurn.mockReset().mockResolvedValue(undefined);
  listPrices.mockReset().mockResolvedValue({});
  complete.mockReset().mockResolvedValue({
    message: { content: 'ok' },
    finishReason: 'stop',
    usage: { prompt: 1, completion: 1 },
  });
});

describe('executeTurn', () => {
  it('records and calls the model the moderator picked', async () => {
    await ask('z-ai/glm-5.3');
    expect(startTurn).toHaveBeenCalledWith(expect.objectContaining({ model: 'z-ai/glm-5.3' }));
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ model: 'z-ai/glm-5.3' }));
  });

  it('runs the default when nothing, or nothing listed, was picked', async () => {
    for (const pick of [null, 'some/unchecked-model']) {
      await ask(pick);
      expect(startTurn).toHaveBeenLastCalledWith(
        expect.objectContaining({ model: 'z-ai/glm-5.3-flash' })
      );
      expect(complete).toHaveBeenLastCalledWith(
        expect.objectContaining({ model: 'z-ai/glm-5.3-flash' })
      );
    }
  });

  it('records the cost at the list price when the live price reads lower', async () => {
    complete.mockResolvedValue({
      message: { content: 'ok' },
      finishReason: 'stop',
      usage: { prompt: 1_000_000, completion: 1_000_000 },
    });
    listPrices.mockResolvedValue({
      'stepfun/step-5-preview': { input: 0.5, output: 3, current: true },
    });
    await ask('stepfun/step-5-preview');
    // List is 1 in / 2.7 out: input at list (1), output at live (3).
    expect(finishTurn).toHaveBeenCalledWith(9, expect.anything(), { usd: 4, source: 'live' });
  });
});
