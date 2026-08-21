import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The orchestrator's workflow shape is `$type`-dependent and it adds step types without asking us, so
 * everything this module does is defensive reading. These cases pin the readings against fixtures
 * taken from real `/v1/manager/workflows` responses (2026-08-21) — a `$type` the parser has never seen
 * must cost nothing, and an output the orchestrator will not serve must be COUNTED rather than
 * rendered as a broken tile.
 */

process.env.ORCHESTRATOR_ENDPOINT = 'https://orchestrator.example';
process.env.ORCHESTRATOR_ACCESS_TOKEN = 'test-token';

const { getUserGeneratedWorkflows } = await import('../user-workflows.service');

const fetchMock = vi.fn();

const respond = (body: unknown, ok = true, status = 200) =>
  fetchMock.mockResolvedValue({
    ok,
    status,
    json: async () => body,
  } as Response);

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

/** An imageGen workflow: two images, one of which the orchestrator no longer serves. */
const imageWorkflow = {
  id: '5-20260818171734275',
  createdAt: '2026-08-18T17:17:34.275Z',
  status: 'Succeeded',
  metadata: {
    params: {
      workflow: 'txt2img',
      ecosystem: 'Flux1',
      prompt: 'a lighthouse',
      negativePrompt: 'blurry',
    },
  },
  steps: [
    {
      $type: 'imageGen',
      output: {
        images: [
          {
            id: 'a.png',
            url: 'https://blobs/a.png',
            available: true,
            width: 1024,
            height: 768,
            nsfwLevel: 'pg',
          },
          // `available: false` still carries a URL, and that URL 404s.
          { id: 'b.png', url: 'https://blobs/b.png', available: false },
        ],
        errors: [],
      },
    },
  ],
};

const videoWorkflow = {
  id: '5-20260817221353172',
  createdAt: '2026-08-17T22:13:53.172Z',
  status: 'Succeeded',
  metadata: { params: { workflow: 'img2vid:ref2vid', ecosystem: 'MiniMaxH3' } },
  steps: [
    {
      $type: 'videoGen',
      output: { progress: 1, video: { id: 'c.mp4', url: 'https://blobs/c.mp4', available: true } },
    },
    // A step type this parser has never seen. It must contribute nothing and throw nothing.
    { $type: 'somethingNew', output: { widgets: [{ id: 'd', url: 'https://blobs/d' }] } },
  ],
};

describe('getUserGeneratedWorkflows', () => {
  it('reads prompts, params and media, and counts what cannot be served', async () => {
    respond({ items: [imageWorkflow, videoWorkflow], next: 'cursor-2' });

    const page = await getUserGeneratedWorkflows(7);

    expect(page.nextCursor).toBe('cursor-2');
    expect(page.items).toHaveLength(2);

    const [image, video] = page.items;
    expect(image.prompt).toBe('a lighthouse');
    expect(image.negativePrompt).toBe('blurry');
    expect(image.workflow).toBe('txt2img');
    expect(image.ecosystem).toBe('Flux1');
    // The unavailable one is counted, NOT returned as media — rendering it gives a broken tile and
    // reads as "the panel is failing" rather than "that output is gone".
    expect(image.media.map((m) => m.id)).toEqual(['a.png']);
    expect(image.media[0]).toMatchObject({ type: 'image', width: 1024, height: 768 });
    expect(image.unavailable).toBe(1);

    expect(video.media).toEqual([expect.objectContaining({ id: 'c.mp4', type: 'video' })]);
    // The unknown step type contributed neither media nor an `unavailable` count.
    expect(video.unavailable).toBe(0);
  });

  it('asks the manager endpoint for that user, generations only, excluding failures', async () => {
    respond({ items: [], next: null });

    await getUserGeneratedWorkflows(42, { cursor: 'abc' });

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toBe('/v1/manager/workflows');
    expect(url.searchParams.get('UserId')).toBe('42');
    // Without the tag the list fills with prompt-enhancement and scan workflows, which answer nothing
    // about what the account made.
    expect(url.searchParams.get('Tags')).toBe('gen');
    expect(url.searchParams.get('ExcludeFailed')).toBe('true');
    expect(url.searchParams.get('Cursor')).toBe('abc');
  });

  it('clamps `take` rather than passing a caller-supplied page size through', async () => {
    respond({ items: [], next: null });

    await getUserGeneratedWorkflows(1, { take: 10_000 });

    expect(new URL(fetchMock.mock.calls[0][0] as string).searchParams.get('Take')).toBe('100');
  });

  it('throws on a refusal instead of returning an empty page', async () => {
    respond({}, false, 403);

    // An empty page and a refused query render identically — "no generations on record" — and only
    // one of them is true.
    await expect(getUserGeneratedWorkflows(1)).rejects.toThrow('403');
  });

  it('drops rows with no id rather than keying a list on undefined', async () => {
    respond({ items: [{ createdAt: 'x' }, imageWorkflow], next: null });

    const page = await getUserGeneratedWorkflows(1);

    expect(page.items.map((w) => w.id)).toEqual([imageWorkflow.id]);
  });
});
