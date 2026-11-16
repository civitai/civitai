import { describe, expect, it, vi } from 'vitest';

const trainingWhatIf = vi.fn();
// Empty: the client's dist imports a directory, which Node's ESM loader refuses; the route needs none of it.
vi.mock('@civitai/orchestration-client', () => ({}));
vi.mock('$lib/server/token', () => ({ requireToken: async () => 'token' }));
vi.mock('$lib/server/orchestrator', () => ({
  trainingWhatIf: (...args: unknown[]) => trainingWhatIf(...args),
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
    const calls = trainingWhatIf.mock.calls.length;
    await expect(post({ ecosystem: 'sdxl', engine: 'kohya' })).rejects.toMatchObject({
      status: 403,
    });
    expect(trainingWhatIf.mock.calls.length).toBe(calls);
  });

  it('quotes Kohya with the gate, and AI Toolkit without it', async () => {
    trainingWhatIf.mockResolvedValue(300);
    kohyaAllowed = true;
    expect(await (await post({ ecosystem: 'sdxl', engine: 'kohya' })).json()).toEqual({
      cost: 300,
    });
    kohyaAllowed = false;
    expect(await (await post({ ecosystem: 'sdxl', engine: 'ai-toolkit' })).json()).toEqual({
      cost: 300,
    });
  });
});
