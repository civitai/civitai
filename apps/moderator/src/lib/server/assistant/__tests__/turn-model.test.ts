import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The model a moderator picks is the one the turn is recorded with AND the one the model call goes
 * to. Either alone would let the audit name a model that never ran, or run one nobody chose.
 */

const { complete, startTurn } = vi.hoisted(() => ({
  complete: vi.fn(),
  startTurn: vi.fn(),
}));

// The real model resolution; only the network call is faked.
vi.mock('../../xguard-api', () => ({ openrouterKey: () => 'test-key' }));
vi.mock('../openrouter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../openrouter')>()),
  complete,
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
  finishTurn: vi.fn(async () => {}),
  renameChat: vi.fn(async () => true),
  hasRunningTurn: vi.fn(async () => false),
  tokensToday: vi.fn(async () => 0),
}));

const { executeTurn } = await import('../turn.service');

const ask = (model: string | null) =>
  executeTurn({
    chatId: 1,
    moderator: { id: 1, username: 'mod' },
    prompt: 'q',
    playbookSlug: null,
    model,
    canAccess: () => true,
    hasGrant: () => true,
    used: 0,
    emit: () => {},
  });

beforeEach(() => {
  startTurn.mockReset().mockResolvedValue(9);
  complete.mockReset().mockResolvedValue({
    message: { content: 'ok' },
    finishReason: 'stop',
    usage: { prompt: 1, completion: 1 },
  });
});

describe('executeTurn', () => {
  it('records and calls the model the moderator picked', async () => {
    await ask('stepfun/step-5-preview');
    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'stepfun/step-5-preview' })
    );
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'stepfun/step-5-preview' })
    );
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
});
