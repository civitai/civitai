import { describe, expect, it } from 'vitest';
import { createSearchClient, SearchServiceError } from '../client';

const respond = (status: number, body: unknown) => async () => Response.json(body, { status });

describe('search client', () => {
  it('returns the ids and sends the token', async () => {
    let auth: string | null = null;
    const client = createSearchClient({
      endpoint: 'http://search.test/',
      token: 't',
      fetch: async (_url, init) => {
        auth = new Headers(init?.headers).get('authorization');
        return Response.json({ ids: [3, 1] });
      },
    });
    const result = await client.images.search({
      query: { text: 'fox' },
      filter: { nsfwLevels: [1] },
    });
    expect(result.ids).toEqual([3, 1]);
    expect(auth).toBe('Bearer t');
  });

  it.each([
    [404, 'not-found'],
    [412, 'not-ready'],
    [502, 'upstream'],
    [503, 'unavailable'],
  ])('maps %i to %s', async (status, code) => {
    const client = createSearchClient({
      endpoint: 'http://search.test',
      fetch: respond(status, { error: 'x' }),
    });
    const err = await client.images
      .search({ query: { similarTo: 1 }, filter: { nsfwLevels: [1] } })
      .catch((e) => e);
    expect(err).toBeInstanceOf(SearchServiceError);
    expect(err.code).toBe(code);
  });

  it('reports an unreachable service as unavailable', async () => {
    const client = createSearchClient({
      endpoint: 'http://search.test',
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await expect(
      client.images.search({ query: { text: 'fox' }, filter: { nsfwLevels: [1] } })
    ).rejects.toMatchObject({ code: 'unavailable' });
  });
});
