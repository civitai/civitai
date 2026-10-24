import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The moderator picks a question's model in the browser, so the server takes only a listed one: each
 * listed model was checked to route under the no-retention policy, and an id from the request body
 * is otherwise anything at all.
 */

const { admitTurn, executeTurn } = vi.hoisted(() => ({
  admitTurn: vi.fn(),
  executeTurn: vi.fn(),
}));
vi.mock('$lib/server/assistant/turn.service', () => ({ admitTurn, executeTurn, BUSY: 'busy' }));
vi.mock('$lib/server/access', () => ({ canAccess: () => true }));

const { POST } = await import('../+server');

const allowance = { spentUsd: 0, capUsd: 1, usedTokens: 0 };

const post = (body: unknown) =>
  (POST as unknown as (e: unknown) => Promise<Response>)({
    params: { chatId: '7' },
    request: new Request('https://moderator.example/assistant/7/turn', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    locals: {
      user: { id: 1, username: 'mod', roles: ['moderator:mod-high-access'] },
      grants: { 'assistant.use': true },
    },
  });

beforeEach(() => {
  admitTurn.mockReset().mockResolvedValue({ ok: true, allowance });
  executeTurn.mockReset().mockResolvedValue({});
});

describe('POST /assistant/[chatId]/turn', () => {
  it('runs the question on the listed model the moderator picked', async () => {
    const res = await post({ prompt: 'q', model: 'z-ai/glm-5.3' });
    await res.text();
    expect(executeTurn).toHaveBeenCalledWith(expect.objectContaining({ model: 'z-ai/glm-5.3' }));
  });

  it('refuses a model outside the list without starting a turn', async () => {
    await expect(post({ prompt: 'q', model: 'some/unchecked-model' })).rejects.toMatchObject({
      status: 400,
      body: { message: 'That model is not one the assistant can use.' },
    });
    expect(admitTurn).not.toHaveBeenCalled();
    expect(executeTurn).not.toHaveBeenCalled();
  });

  it('runs the default when no model is picked', async () => {
    const res = await post({ prompt: 'q' });
    await res.text();
    expect(executeTurn).toHaveBeenCalledWith(expect.objectContaining({ model: null }));
  });

  it("admits the turn against the moderator's own roles, and runs it on that allowance", async () => {
    const res = await post({ prompt: 'q' });
    await res.text();
    expect(admitTurn).toHaveBeenCalledWith(7, { id: 1, roles: ['moderator:mod-high-access'] });
    expect(executeTurn).toHaveBeenCalledWith(expect.objectContaining({ allowance }));
  });
});
