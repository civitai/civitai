import instantsearch from 'instantsearch.js';
import { describe, expect, it, vi } from 'vitest';
import { connectSimilarImage } from '~/components/Search/useSimilarImage';

type Request = { indexName: string; params: Record<string, unknown> };

// A real InstantSearch with a client that records what it was sent, so the test covers the real
// helper carrying `similarTo` through to the request (it only types Algolia's own parameters).
function start(uiState: Record<string, unknown>) {
  const requests: Request[][] = [];
  const searchClient = {
    search: vi.fn(async (batch: Request[]) => {
      requests.push(batch);
      return { results: batch.map(() => ({ hits: [], nbHits: 0, page: 0, nbPages: 0 })) };
    }),
  };
  let refine: ((imageId?: number) => void) | undefined;
  const search = instantsearch({
    indexName: 'images',
    searchClient: searchClient as never,
    initialUiState: { images: uiState },
  });
  search.addWidgets([connectSimilarImage((state) => (refine = state.refine))({})]);
  search.start();
  const lastParams = () => requests.at(-1)?.[0]?.params;
  return { search, requests, lastParams, refine: (id?: number) => refine!(id) };
}

describe('connectSimilarImage', () => {
  it('sends similarTo from the UI state with the search and writes it back', async () => {
    const { search, lastParams } = start({ similarTo: 42 });
    await vi.waitFor(() => expect(lastParams()).toMatchObject({ similarTo: 42 }));
    expect(search.getUiState().images).toMatchObject({ similarTo: 42 });
    search.dispose();
  });

  it('leaves similarTo out of both when the UI state has none', async () => {
    const { search, lastParams } = start({});
    await vi.waitFor(() => expect(lastParams()).toBeDefined());
    expect(lastParams()).not.toHaveProperty('similarTo');
    expect(search.getUiState().images).not.toHaveProperty('similarTo');
    search.dispose();
  });

  it('clears similarTo from the next search when refined to nothing (the banner Clear)', async () => {
    const { search, requests, lastParams, refine } = start({ similarTo: 42 });
    await vi.waitFor(() => expect(lastParams()).toMatchObject({ similarTo: 42 }));
    const sent = requests.length;

    refine(undefined);

    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(sent));
    expect(lastParams()).not.toHaveProperty('similarTo');
    expect(search.getUiState().images).not.toHaveProperty('similarTo');
    search.dispose();
  });
});
