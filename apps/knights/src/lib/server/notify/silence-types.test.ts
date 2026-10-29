import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({
  env: { CIVITAI_APP_URL: 'https://app.test/', WEBHOOK_TOKEN: 'secret' },
}));

const { fetchSilenceTypes } = await import('./silence-types');

const answer = (body: unknown, ok = true) =>
  vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => body } as Response));

afterEach(() => vi.restoreAllMocks());

describe('fetchSilenceTypes', () => {
  it('reads the list from the main app with the shared token', async () => {
    const fetcher = answer({ types: ['a', 'b'] });

    expect(await fetchSilenceTypes(fetcher)).toEqual(['a', 'b']);
    expect(fetcher).toHaveBeenCalledWith(
      'https://app.test/api/mod/knights/notification-types',
      expect.objectContaining({ headers: { 'x-webhook-token': 'secret' } })
    );
  });

  it.each([
    ['an error status', answer({ types: ['a'] }, false)],
    ['an empty list', answer({ types: [] })],
    ['an unexpected shape', answer({ nope: 1 })],
    ['a list of non-strings', answer({ types: [1, 2] })],
    ['a network failure', vi.fn().mockRejectedValue(new Error('down'))],
  ])('answers an empty list for %s, and warns', async (_, fetcher) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(await fetchSilenceTypes(fetcher)).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});
