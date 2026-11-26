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
    const fetcher = answer({
      types: [
        { type: 'a', firstSeen: '2026-01-01T00:00:00.000Z' },
        { type: 'b', firstSeen: '2026-06-01T00:00:00.000Z' },
      ],
    });

    expect(await fetchSilenceTypes(fetcher)).toEqual([
      { type: 'a', firstSeen: new Date('2026-01-01T00:00:00.000Z') },
      { type: 'b', firstSeen: new Date('2026-06-01T00:00:00.000Z') },
    ]);
    expect(fetcher).toHaveBeenCalledWith(
      'https://app.test/api/mod/knights/notification-types',
      expect.objectContaining({ headers: { 'x-webhook-token': 'secret' } })
    );
  });

  it.each([
    [
      'an error status',
      answer({ types: [{ type: 'a', firstSeen: '2026-01-01T00:00:00Z' }] }, false),
    ],
    ['an empty list', answer({ types: [] })],
    ['an unexpected shape', answer({ nope: 1 })],
    ['a list of bare names', answer({ types: ['a', 'b'] })],
    ['an unreadable time', answer({ types: [{ type: 'a', firstSeen: 'soon' }] })],
    ['a network failure', vi.fn().mockRejectedValue(new Error('down'))],
  ])('answers an empty list for %s, and warns', async (_, fetcher) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(await fetchSilenceTypes(fetcher)).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});
