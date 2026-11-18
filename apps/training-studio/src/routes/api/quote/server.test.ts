import { describe, expect, it, vi } from 'vitest';

const trainingPreview = vi.fn();
// Empty: the client's dist imports a directory, which Node's ESM loader refuses; the route needs none of it.
vi.mock('@civitai/orchestration-client', () => ({}));
vi.mock('$lib/server/token', () => ({ requireToken: async () => 'token' }));
vi.mock('$lib/server/orchestrator', () => ({
  trainingPreview: (...args: unknown[]) => trainingPreview(...args),
}));
let kohyaAllowed = false;
vi.mock('$lib/server/flipt', () => ({ isKohyaAllowed: async () => kohyaAllowed }));

const { POST } = await import('./+server');

const post = (body: unknown) =>
  POST({
    locals: { user: { id: 1 } },
    request: new Request('http://x/api/quote', { method: 'POST', body: JSON.stringify(body) }),
  } as unknown as Parameters<typeof POST>[0]);

describe('POST /api/quote', () => {
  it('refuses a Kohya quote without the gate, before asking the orchestrator', async () => {
    kohyaAllowed = false;
    const calls = trainingPreview.mock.calls.length;
    await expect(post({ ecosystem: 'sdxl', engine: 'kohya' })).rejects.toMatchObject({
      status: 403,
    });
    expect(trainingPreview.mock.calls.length).toBe(calls);
  });

  it('quotes Kohya with the gate, and AI Toolkit without it', async () => {
    const quote = { cost: 300, warnings: [] };
    trainingPreview.mockResolvedValue(quote);
    kohyaAllowed = true;
    expect(await (await post({ ecosystem: 'sdxl', engine: 'kohya' })).json()).toEqual(quote);
    kohyaAllowed = false;
    expect(await (await post({ ecosystem: 'sdxl', engine: 'ai-toolkit' })).json()).toEqual(quote);
  });
});
