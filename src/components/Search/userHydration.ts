import type { InstantSearchProps } from 'react-instantsearch';

/**
 * Replaces the avatar baked into a search document with the current one.
 *
 * Five indexes denormalize `user.profilePicture` into every document its owner owns, and
 * nothing rebuilds an existing document when the avatar changes — `prepareBatches` filters
 * on `"createdAt" >= lastUpdatedAt`, so only NEWLY CREATED rows are revisited. The copy is
 * therefore stale until something else happens to touch the document, and turns into a
 * broken image once `remove-replaced-images` reaps the original 30 days later. Measured on
 * production: 100 of 120 sampled `collections_v3` documents and 69 of 120 `models_v9`.
 *
 * 🔴 THIS SITS IN `searchClient.search`, NOT IN `transformItems`. `transformItems` is
 * `(items, metadata) => TItem[]` — synchronous, so it cannot fetch. It still runs, after
 * this, and shapes what this put on the hits; the two are not alternatives. Anything
 * needing an await belongs here, which is the only async seam InstantSearch exposes.
 *
 * 🔴 AND IT MUST STAY INSIDE `search`, not in a component after `useHits`. Resolving both
 * calls before returning is what makes the response atomic: the widgets are handed one
 * complete result set, never a half-hydrated one that renders authorless and then
 * re-renders. That is the whole reason this is not a React query.
 *
 * While the documents still carry the field, a hydration failure falls back to the stored
 * copy — stale, but exactly what users see today, so this can only improve on it. That
 * stops being true when the field is dropped from the documents, which is why the failure
 * policy has to be settled before that step rather than after.
 */

/** Indexes whose documents carry `user.profilePicture`. `users_v3` is excluded: a change
 *  to a user's own record already enqueues that index, so it is not stale. */
const HYDRATED_INDEX_PREFIXES = ['models', 'images', 'collections', 'bounties', 'comics'];

const isHydratedIndex = (indexName: string | undefined) =>
  !!indexName && HYDRATED_INDEX_PREFIXES.some((prefix) => indexName.startsWith(prefix));

/** Matches the schema's cap. A page of hits is far below it; see the schema comment. */
const MAX_IDS = 200;

type SearchClient = NonNullable<InstantSearchProps['searchClient']>;
type SearchResponse = Awaited<ReturnType<SearchClient['search']>>;

type HitWithUser = { user?: { id?: number; profilePicture?: unknown } | null };

type ProfilePictures = Record<number, unknown>;

// Imported lazily so this module does not pull the tRPC client in at load. That import
// reaches a large graph, and every test importing anything downstream of here would have
// to mock it — a mock that replaces the module wholesale, which is the failure mode
// `no-wholesale-module-mock` exists to stop.
const fetchProfilePictures = async (ids: number[]): Promise<ProfilePictures> => {
  const { trpcVanilla } = await import('~/utils/trpc');
  const result = await trpcVanilla.user.getSearchHydration.query({ ids });
  return result.profilePictures as ProfilePictures;
};

function collectUserIds(response: SearchResponse) {
  const ids = new Set<number>();
  for (const result of response.results ?? []) {
    const { hits, index } = result as { hits?: HitWithUser[]; index?: string };
    if (!isHydratedIndex(index)) continue;
    for (const hit of hits ?? []) {
      const id = hit?.user?.id;
      if (typeof id === 'number') ids.add(id);
    }
  }
  return [...ids].slice(0, MAX_IDS);
}

function applyProfilePictures(response: SearchResponse, pictures: ProfilePictures) {
  for (const result of response.results ?? []) {
    const { hits, index } = result as { hits?: HitWithUser[]; index?: string };
    if (!isHydratedIndex(index)) continue;
    for (const hit of hits ?? []) {
      const id = hit?.user?.id;
      if (typeof id !== 'number') continue;
      // `in`, not a truthiness check: a user with no avatar is `null` in the cache, and
      // that null is the correct answer. Skipping it would leave the document's stale
      // picture on a user who has since removed theirs.
      if (id in pictures && hit.user) hit.user.profilePicture = pictures[id];
    }
  }
  return response;
}

export function withUserHydration(
  client: SearchClient,
  fetchPictures: (ids: number[]) => Promise<ProfilePictures> = fetchProfilePictures
): SearchClient {
  return {
    ...client,
    async search(requests) {
      const response = (await client.search(requests)) as SearchResponse;

      const ids = collectUserIds(response);
      if (!ids.length) return response;

      try {
        return applyProfilePictures(response, await fetchPictures(ids));
      } catch {
        // Never rethrow: the search itself succeeded, and the documents still carry a
        // copy of the avatar. Failing here would turn a working result set into no
        // results at all, to avoid showing what the page shows today anyway.
        return response;
      }
    },
  } as SearchClient;
}
