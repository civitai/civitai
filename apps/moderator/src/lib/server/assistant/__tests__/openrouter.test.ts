import { afterEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted((): Record<string, string | undefined> => ({}));
vi.mock('$env/dynamic/private', () => ({ env }));
vi.mock('../../xguard-api', () => ({ openrouterKey: () => 'test-key' }));

const { assistantModel, complete, listPrices, reasoningOf } = await import('../openrouter');

describe('listPrices', () => {
  const HOUR = 60 * 60_000;
  // Each case starts past the cache of the one before.
  let clock = 0;
  const later = () => (clock += 2 * HOUR);

  it("takes OpenRouter's current list price, per million, for a listed model", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          data: [
            { id: 'z-ai/glm-5.3-flash', pricing: { prompt: '0.0000003', completion: '0.000001' } },
            { id: 'not/listed', pricing: { prompt: '1', completion: '1' } },
          ],
        })
      )
    );
    const prices = await listPrices(later());
    expect(prices['z-ai/glm-5.3-flash'].input).toBeCloseTo(0.3, 10);
    expect(prices['z-ai/glm-5.3-flash'].output).toBeCloseTo(1, 10);
    expect(prices['z-ai/glm-5.3-flash'].current).toBe(true);
    // A model the list did not return keeps the release's price, marked not current; an unlisted
    // one is never added.
    expect(prices['z-ai/glm-5.3']).toEqual({ input: 0.079, output: 1.4 });
    expect(prices['not/listed']).toBeUndefined();
  });

  it('falls back to the release prices when OpenRouter cannot be reached', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      })
    );
    expect((await listPrices(later()))['z-ai/glm-5.3-flash']).toEqual({ input: 0.15, output: 0.5 });
  });

  it('keeps the release price for a model whose listed price is missing or the "-1" sentinel', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          data: [
            { id: 'z-ai/glm-5.3-flash', pricing: { prompt: '0.0000003', completion: '-1' } },
            { id: 'z-ai/glm-5.3', pricing: { prompt: null, completion: null } },
          ],
        })
      )
    );
    const prices = await listPrices(later());
    expect(prices['z-ai/glm-5.3-flash']).toEqual({ input: 0.15, output: 0.5 });
    expect(prices['z-ai/glm-5.3']).toEqual({ input: 0.079, output: 1.4 });
  });

  it('retries a failed read after minutes, not an hour', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetch = vi.fn(async () => new Response('<html>bad gateway</html>', { status: 502 }));
    vi.stubGlobal('fetch', fetch);
    const at = later();
    await listPrices(at);
    await listPrices(at + 6 * 60_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('asks at most hourly', async () => {
    const fetch = vi.fn(async () => Response.json({ data: [] }));
    vi.stubGlobal('fetch', fetch);
    const at = later();
    await listPrices(at);
    await listPrices(at + HOUR / 2);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete env.ASSISTANT_MODEL;
});

describe('assistantModel', () => {
  it('takes ASSISTANT_MODEL when it names a listed model', () => {
    env.ASSISTANT_MODEL = ' z-ai/glm-5.3 ';
    expect(assistantModel()).toBe('z-ai/glm-5.3');
  });

  it('ignores a model outside the list, which was never checked for the no-retention policy', () => {
    env.ASSISTANT_MODEL = 'some/unchecked-model';
    expect(assistantModel()).toBe('z-ai/glm-5.3-flash');
  });
});

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

  it('asks for the model it was given, only from providers that keep nothing and honour tools', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) =>
      Response.json({ choices: [{ message: { content: 'ok' } }] })
    );
    vi.stubGlobal('fetch', fetch);
    await complete({ model: 'z-ai/glm-5.3', messages: [{ role: 'user', content: 'q' }] });
    const sent = JSON.parse(fetch.mock.calls[0][1].body as string);
    expect(sent.model).toBe('z-ai/glm-5.3');
    expect(sent.provider).toEqual({ data_collection: 'deny', require_parameters: true });
  });

  // With `require_parameters`, one unsupported parameter leaves no endpoint at all: GPT-6 Luna under
  // the no-retention policy came back 404 until temperature was dropped for it.
  it('sends temperature only to a model that accepts it', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) =>
      Response.json({ choices: [{ message: { content: 'ok' } }] })
    );
    vi.stubGlobal('fetch', fetch);
    const sent = async (model: string) => {
      await complete({ model, messages: [{ role: 'user', content: 'q' }] });
      return JSON.parse(fetch.mock.calls.at(-1)![1].body as string);
    };
    expect((await sent('openai/gpt-6-luna')).temperature).toBeUndefined();
    expect((await sent('z-ai/glm-5.3-flash')).temperature).toBe(0.2);
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
