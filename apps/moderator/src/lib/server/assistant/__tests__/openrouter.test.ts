import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('../../xguard-api', () => ({ openrouterKey: () => 'test-key' }));

const { complete, reasoningOf } = await import('../openrouter');

afterEach(() => vi.unstubAllGlobals());

describe('complete', () => {
  it("returns the answer and the completion's reasoning, whatever field carried it", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          choices: [
            {
              message: {
                content: 'It is [user:5].',
                reasoning: null,
                reasoning_details: [{ type: 'reasoning.text', text: '- look up 5' }],
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        })
      )
    );
    const out = await complete({ model: 'm', messages: [{ role: 'user', content: 'q' }] });
    expect(out.message).toMatchObject({ content: 'It is [user:5].', reasoning: '- look up 5' });
  });
});

/**
 * Reasoning is display only. Whatever shape a provider returns it in, a good answer in the same
 * completion must survive, and readable reasoning should not be lost to a model family's field choice.
 */
describe('reasoningOf', () => {
  it('reads the plain reasoning string', () => {
    expect(reasoningOf({ reasoning: '- look up 5' })).toBe('- look up 5');
  });

  it('falls back to the readable reasoning_details when the string is empty', () => {
    expect(
      reasoningOf({
        reasoning: '',
        reasoning_details: [
          { type: 'reasoning.summary', summary: 'checked the account' },
          { type: 'reasoning.encrypted', data: 'opaque' },
          { type: 'reasoning.text', text: 'then its reports' },
        ],
      })
    ).toBe('checked the account\n\nthen its reports');
  });

  it('reads anything not shaped as documented as no reasoning, never a throw', () => {
    for (const message of [
      { reasoning: { text: 'x' } },
      { reasoning: 42 },
      { reasoning_details: 'x' },
      { reasoning_details: [null, 7, { type: 'reasoning.encrypted', data: 'opaque' }] },
      {},
    ])
      expect(reasoningOf(message)).toBeNull();
  });
});
