import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyConsensusToMainApp } from './main-app';

const application = { questionKey: 'knights.image.nsfwLevel', imageId: 12, value: '8', actorId: 9 };
const fetchMock = vi.fn<typeof fetch>();

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
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    await applyConsensusToMainApp(application);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://main.example/api/mod/image/kono-set-nsfw-level');
    expect(new Headers(init?.headers).get('x-webhook-token')).toBe('secret');
    expect(JSON.parse(String(init?.body))).toEqual({ imageId: 12, nsfwLevel: 8, userId: 9 });
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
