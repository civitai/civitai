import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportImageToMainApp } from './image-report';

const fetchMock = vi.fn<typeof fetch>();
const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

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

describe('reportImageToMainApp', () => {
  it('posts only the image id to the report route, with the shared token in a header, and returns the report id', async () => {
    fetchMock.mockResolvedValue(answer({ reportId: 31, created: true }));
    expect(await reportImageToMainApp(12)).toBe(31);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://main.example/api/mod/image/kono-report-image');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('x-webhook-token')).toBe('secret');
    expect(JSON.parse(String(init?.body))).toEqual({ imageId: 12 });
  });

  it('takes the existing report of a repeat the same way', async () => {
    fetchMock.mockResolvedValue(answer({ reportId: 31, created: false }));
    expect(await reportImageToMainApp(12)).toBe(31);
  });

  it.each([
    ['a refusal', () => answer({ error: 'nope' }, 404)],
    ['an answer with no report id', () => answer({ created: true })],
    ['a body that is not JSON', () => new Response('<html>', { status: 200 })],
  ])('throws on %s, so the pull is filed again later', async (_case, response) => {
    fetchMock.mockResolvedValue(response());
    await expect(reportImageToMainApp(12)).rejects.toThrow();
  });

  it('throws without calling anything when the token is not configured', async () => {
    delete process.env.WEBHOOK_TOKEN;
    await expect(reportImageToMainApp(12)).rejects.toThrow('WEBHOOK_TOKEN');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
