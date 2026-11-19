import { describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { InstantSearch } from 'react-instantsearch';
import { renderWithProviders } from '../../../test/component-setup';
import { DateRangeRefinement } from '~/components/Search/CustomSearchComponents';

type RecordedRequest = { params?: { numericFilters?: unknown; hitsPerPage?: number } };

function createRecordingClient() {
  const requests: RecordedRequest[] = [];
  const searchClient = {
    search: (queries: RecordedRequest[]) => {
      requests.push(...queries);
      return Promise.resolve({
        results: queries.map(() => ({
          hits: [],
          nbHits: 0,
          nbPages: 0,
          page: 0,
          processingTimeMS: 0,
          hitsPerPage: 0,
          exhaustiveNbHits: false,
          query: '',
          params: '',
        })),
      });
    },
  };
  return { requests, searchClient };
}

const START = new Date('2026-10-01T00:00:00Z').getTime();

describe('DateRangeRefinement', () => {
  it('lets a set start date be cleared, and the search drops the date bound', async () => {
    const { requests, searchClient } = createRecordingClient();
    renderWithProviders(
      <InstantSearch
        searchClient={searchClient as never}
        indexName="images_v6"
        initialUiState={{ images_v6: { range: { createdAtUnix: `${START}:` } } }}
      >
        <DateRangeRefinement title="Filter by Posted Date" attribute="createdAtUnix" />
      </InstantSearch>
    );
    // The range widget also sends a hits-less request for its facet stats; the search is the other.
    const lastSearch = () => requests.filter((r) => r.params?.hitsPerPage !== 0).at(-1);
    const bound = (request?: RecordedRequest) =>
      JSON.stringify(request?.params?.numericFilters ?? []).includes('createdAtUnix');

    await vi.waitFor(() => expect(bound(lastSearch())).toBe(true));

    await userEvent.click(page.getByRole('button', { name: 'Clear start date' }));

    await vi.waitFor(() => expect(bound(lastSearch())).toBe(false));
  });
});
