import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The model a moderator picks is the one the turn is recorded with AND the one the model call goes
 * to. Either alone would let the audit name a model that never ran, or run one nobody chose.
 */

const { complete, startTurn, finishTurn, listPrices, recordTurnTokens } = vi.hoisted(() => ({
  recordTurnTokens: vi.fn(),
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
  recordTurnTokens,
  renameChat: vi.fn(async () => true),
  hasRunningTurn: vi.fn(async () => false),
  tokensToday: vi.fn(async () => 0),
}));

const { executeTurn } = await import('../turn.service');
const { BUDGET_NOTICE, TURN_TOKEN_BUDGET } = await import('../loop');

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
  recordTurnTokens.mockReset().mockResolvedValue(undefined);
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
    expect(finishTurn).toHaveBeenCalledTimes(1);
    expect(finishTurn).toHaveBeenCalledWith(9, expect.anything(), { usd: 4, source: 'live' });
  });

  it('stops the turn once it has spent the dollars left, priced at the model’s dearer direction', async () => {
    // One cent left on Step 5 (dearest direction $2.70/M) is 3,703 tokens; the call spends 5,000.
    complete.mockResolvedValue({
      message: {
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'none', arguments: '{}' } }],
      },
      finishReason: 'tool_calls',
      usage: { prompt: 4_000, completion: 1_000 },
    });
    const outcome = await ask('stepfun/step-5-preview', {
      spentUsd: 0.99,
      capUsd: 1,
      usedTokens: 0,
    });
    expect(outcome.status).toBe('capped');
    expect(complete).toHaveBeenCalledTimes(1);
    // Recorded before the turn ends, so a process that dies here still leaves the spend on the row.
    expect(recordTurnTokens).toHaveBeenCalledWith(9, 4_000, 1_000);
  });

  it("tells the model this question's budget, as the setting resolves it, and when it is unset", async () => {
    const system = () =>
      (complete.mock.lastCall![0] as { messages: { content: string }[] }).messages[0].content;
    const before = process.env.ASSISTANT_TURN_TOKEN_BUDGET;
    try {
      process.env.ASSISTANT_TURN_TOKEN_BUDGET = '40000';
      await ask(null);
      expect(system()).toContain('about 40,000 tokens');
      // ...and the loop stops at that same number, not at the default the prompt no longer states.
      complete.mockResolvedValueOnce({
        message: {
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'none', arguments: '{}' } }],
        },
        finishReason: 'tool_calls',
        usage: { prompt: 41_000, completion: 0 },
      });
      expect((await ask(null)).answer).toContain(BUDGET_NOTICE);
      delete process.env.ASSISTANT_TURN_TOKEN_BUDGET;
      await ask(null);
      expect(system()).toContain(`about ${TURN_TOKEN_BUDGET.toLocaleString('en-US')} tokens`);
    } finally {
      if (before === undefined) delete process.env.ASSISTANT_TURN_TOKEN_BUDGET;
      else process.env.ASSISTANT_TURN_TOKEN_BUDGET = before;
    }
  });
});
