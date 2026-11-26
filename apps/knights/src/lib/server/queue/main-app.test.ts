import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyConsensusToMainApp } from './main-app';

const application = { questionKey: 'knights.image.nsfwLevel', imageId: 12, value: '8', actorId: 9 };
const fetchMock = vi.fn<typeof fetch>();
const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const applied = () => answer({ imageId: 12, outcome: 'applied', nsfwLevel: 8 });

beforeEach(() => {
  process.env.WEBHOOK_TOKEN = 'secret';
  process.env.CIVITAI_APP_URL = 'https://main.example/';
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  delete process.env.WEBHOOK_TOKEN;
  delete process.env.CIVITAI_APP_URL;
});

describe('applyConsensusToMainApp', () => {
  it('posts the rating to the Knights endpoint with the shared token in a header', async () => {
    fetchMock.mockResolvedValue(applied());
    await applyConsensusToMainApp(application);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://main.example/api/mod/image/kono-set-nsfw-level');
    expect(new Headers(init?.headers).get('x-webhook-token')).toBe('secret');
    expect(JSON.parse(String(init?.body))).toEqual({ imageId: 12, nsfwLevel: 8, userId: 9 });
  });

  it('reports the main app applying the rating', async () => {
    fetchMock.mockResolvedValue(applied());
    expect(await applyConsensusToMainApp(application)).toEqual({ outcome: 'applied' });
  });

  it.each(['missing', 'blocked', 'locked'] as const)(
    'reports a %s skip as an outcome, not an error',
    async (reason) => {
      fetchMock.mockResolvedValue(
        answer({ imageId: 12, outcome: 'skipped', reason, currentLevel: 4 })
      );
      expect(await applyConsensusToMainApp(application)).toEqual({
        outcome: 'skipped',
        reason,
        currentLevel: 4,
      });
    }
  );

  it.each([
    ['an unknown outcome', answer({ outcome: 'maybe' })],
    ['an unknown skip reason', answer({ outcome: 'skipped', reason: 'sleepy' })],
    ['a body that is not JSON', new Response('<html>', { status: 200 })],
  ])('throws on %s, so the item is retried', async (_label, response) => {
    fetchMock.mockResolvedValue(response);
    await expect(applyConsensusToMainApp(application)).rejects.toThrow(/outcome/);
  });

  it('treats a rejected request body as transient: it is retried, never skipped', async () => {
    fetchMock.mockResolvedValue(answer({ error: 'Invalid request' }, 400));
    await expect(applyConsensusToMainApp(application)).rejects.toThrow(/400/);
  });

  it('throws when the main app refuses, so the vote is not counted', async () => {
    fetchMock.mockResolvedValue(new Response('no', { status: 500 }));
    await expect(applyConsensusToMainApp(application)).rejects.toThrow(/500/);
  });

  it('throws instead of skipping when the token is not configured', async () => {
    delete process.env.WEBHOOK_TOKEN;
    await expect(applyConsensusToMainApp(application)).rejects.toThrow(/WEBHOOK_TOKEN/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ignores questions it has no write-back for', async () => {
    await applyConsensusToMainApp({ ...application, questionKey: 'knights.test.bool' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
