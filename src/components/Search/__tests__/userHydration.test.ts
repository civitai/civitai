import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The defect: five indexes bake `user.profilePicture` into every document its owner owns,
 * and no incremental sweep revisits an existing document when the avatar changes. These
 * pin that the stored copy is REPLACED on the way out of the search client, and that a
 * failure to do so still returns the search.
 */

vi.mock('~/utils/trpc', () => ({ trpcVanilla: { user: { getSearchHydration: { query: vi.fn() } } } }));

import { withUserHydration } from '~/components/Search/userHydration';

const USER_A = 3319;
const USER_B = 8801;
const STALE_PICTURE = { id: 111, url: 'stale-url' };
const CURRENT_PICTURE = { id: 999, url: 'current-url' };

const hit = (userId: number, profilePicture: unknown = STALE_PICTURE) => ({
  objectID: `${userId}`,
  user: { id: userId, profilePicture },
});

const response = (index: string, ...hits: unknown[]) => ({ results: [{ index, hits }] });

const clientReturning = (res: unknown) => ({ search: vi.fn(async () => res) } as never);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('withUserHydration', () => {
  it('replaces the stored avatar with the current one', async () => {
    const fetchPictures = vi.fn(async () => ({ [USER_A]: CURRENT_PICTURE }));
    const client = withUserHydration(
      clientReturning(response('collections_v3', hit(USER_A))),
      fetchPictures
    );

    const result = (await client.search([] as never)) as ReturnType<typeof response>;

    expect(fetchPictures).toHaveBeenCalledWith([USER_A]);
    expect((result.results[0].hits[0] as { user: { profilePicture: unknown } }).user.profilePicture)
      .toEqual(CURRENT_PICTURE);
  });

  // A user who removed their avatar reads as `null` from the cache, and that null is the
  // answer. A truthiness check would skip it and leave the document's stale picture on a
  // user who no longer has one — the same bug, in the one case that looks like no data.
  it('applies a null avatar, rather than treating it as no answer', async () => {
    const client = withUserHydration(
      clientReturning(response('models_v9', hit(USER_A))),
      async () => ({ [USER_A]: null })
    );

    const result = (await client.search([] as never)) as ReturnType<typeof response>;

    expect((result.results[0].hits[0] as { user: { profilePicture: unknown } }).user.profilePicture)
      .toBeNull();
  });

  it('asks once for a user appearing on many hits', async () => {
    const fetchPictures = vi.fn(async () => ({}));
    const client = withUserHydration(
      clientReturning(response('bounties_v3', hit(USER_A), hit(USER_A), hit(USER_B))),
      fetchPictures
    );

    await client.search([] as never);

    expect(fetchPictures).toHaveBeenCalledWith([USER_A, USER_B]);
  });

  // `users_v3` is already enqueued when a user's own record changes, so hydrating it
  // would be a request per search for data that is not stale.
  it('does not hydrate indexes that are not stale', async () => {
    const fetchPictures = vi.fn(async () => ({}));
    const client = withUserHydration(
      clientReturning(response('users_v3', hit(USER_A))),
      fetchPictures
    );

    await client.search([] as never);

    expect(fetchPictures).not.toHaveBeenCalled();
  });

  it('does not call out at all when no hit carries a user', async () => {
    const fetchPictures = vi.fn(async () => ({}));
    const client = withUserHydration(
      clientReturning(response('collections_v3', { objectID: '1' })),
      fetchPictures
    );

    await client.search([] as never);

    expect(fetchPictures).not.toHaveBeenCalled();
  });

  // The search succeeded and the documents still carry a copy. Failing here would trade a
  // working result set for no results, to avoid showing what the page shows today anyway.
  it('returns the search when hydration fails, keeping the stored copy', async () => {
    const client = withUserHydration(
      clientReturning(response('collections_v3', hit(USER_A))),
      async () => {
        throw new Error('network');
      }
    );

    const result = (await client.search([] as never)) as ReturnType<typeof response>;

    expect((result.results[0].hits[0] as { user: { profilePicture: unknown } }).user.profilePicture)
      .toEqual(STALE_PICTURE);
  });

  // A rejection here reaches react-instantsearch as a failed search: no results, not stale
  // ones. The catch above is what prevents it, so this asserts the promise settles.
  it('never rejects', async () => {
    const client = withUserHydration(
      clientReturning(response('models_v9', hit(USER_A))),
      async () => {
        throw new Error('boom');
      }
    );

    await expect(client.search([] as never)).resolves.toBeDefined();
  });

  it('leaves a failing search to the caller rather than swallowing it', async () => {
    // Only hydration is guarded. A Meili failure is `resilientSearchClient`'s job, and
    // catching it here would hide an outage behind an empty result set.
    const client = withUserHydration(
      { search: vi.fn(async () => Promise.reject(new Error('meili down'))) } as never,
      async () => ({})
    );

    await expect(client.search([] as never)).rejects.toThrow('meili down');
  });
});
