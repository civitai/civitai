import { afterEach, describe, expect, it, vi } from 'vitest';
import { pollAutoLabel, submitAutoLabel, upstreamStatus } from './autolabel';

function answer(status: number, body: unknown) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

const items = [
  { key: 't1', mediaUrl: 'https://x/a.png' },
  { key: 't2', mediaUrl: 'https://x/b.png' },
];

describe('auto-label through the main app', () => {
  afterEach(() => vi.unstubAllGlobals());

  it("submits to the main app's system-paid route as this user", async () => {
    const fetch = answer(200, { workflowId: 'wf', stepCount: 2 });
    await expect(submitAutoLabel('civ-token=x', 'tag', 'image', items)).resolves.toBe('wf');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://civitai.com/api/training-studio/auto-label');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect((init.headers as Record<string, string>).cookie).toBe('civ-token=x');
    expect(JSON.parse(init.body as string)).toEqual({
      mediaType: 'image',
      images: [
        { mediaUrl: 'https://x/a.png', filename: 't1' },
        { mediaUrl: 'https://x/b.png', filename: 't2' },
      ],
      params: { type: 'tag', threshold: 0.35 },
    });
  });

  it("maps the poll back to the caller's keys", async () => {
    answer(200, {
      status: 'processing',
      steps: [
        { status: 'succeeded', filename: 't1', output: { tags: { b: 0.4, a: 0.9 } } },
        { status: 'succeeded', filename: 't2', output: { caption: 'a dog' } },
        { status: 'failed', filename: 't3', output: null },
        { status: 'processing', filename: 't4', output: null },
      ],
    });
    await expect(pollAutoLabel('', 'wf')).resolves.toEqual({
      done: false,
      results: [
        { key: 't1', status: 'succeeded', tags: ['a', 'b'] },
        { key: 't2', status: 'succeeded', caption: 'a dog' },
        { key: 't3', status: 'failed' },
        { key: 't4', status: 'pending' },
      ],
    });
  });

  it.each([
    [429, 429],
    [404, 404],
    [403, 403],
    [500, 502],
    [503, 502],
  ])('a %i from the main app answers %i', async (status, expected) => {
    answer(status, { error: 'nope' });
    const err = await submitAutoLabel('', 'caption', 'image', items).catch((e: unknown) => e);
    expect(upstreamStatus(err)).toBe(expected);
  });
});
