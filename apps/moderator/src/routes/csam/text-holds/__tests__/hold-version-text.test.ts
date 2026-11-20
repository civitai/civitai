import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchHoldVersionTexts } from '../hold-version-text';

const respond = (status: number, body: unknown = {}) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status }))
  );

afterEach(() => vi.unstubAllGlobals());

describe('fetchHoldVersionTexts', () => {
  it('reads a hold that no longer names flagged text (404) as gone, not as an error', async () => {
    respond(404);
    await expect(fetchHoldVersionTexts(7)).resolves.toEqual({ gone: true });
  });

  it('throws on any other failure, so the card offers a retry', async () => {
    respond(500);
    await expect(fetchHoldVersionTexts(7)).rejects.toThrow('500');
  });

  it('returns the hits of a found hold, from its own route', async () => {
    const body = { hits: [{ versionId: 1, field: 'name', text: 'v', state: 'unchanged' }] };
    respond(200, body);
    await expect(fetchHoldVersionTexts(7)).resolves.toEqual(body);
    expect(fetch).toHaveBeenCalledWith('/api/csam-hold-version-text/7');
  });
});
