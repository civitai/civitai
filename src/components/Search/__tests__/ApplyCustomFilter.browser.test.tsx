import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { InstantSearch } from 'react-instantsearch';
import { ApplyCustomFilter } from '~/components/Search/CustomSearchComponents';

type RecordedRequest = { params?: Record<string, unknown> };

function createRecordingClient() {
  const requests: RecordedRequest[] = [];

  return {
    requests,
    searchClient: {
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
    },
  };
}

// Every request is asserted, not only the settled one: the widget registers with the full props and
// is then re-refined by ApplyCustomFilter's own effect, and a refine that drops `hitsPerPage` still
// ends up carrying it again by the time the searches stop.
describe('ApplyCustomFilter', () => {
  it('keeps its other Configure params on every request it drives', async () => {
    const { requests, searchClient } = createRecordingClient();

    render(
      <InstantSearch searchClient={searchClient as never} indexName="models_v9">
        <ApplyCustomFilter filters={['nsfwLevel=1']} hitsPerPage={6} />
      </InstantSearch>
    );

    await vi.waitFor(() => {
      expect(requests.length).toBeGreaterThanOrEqual(2);
      expect(requests.map((r) => [r.params?.filters, r.params?.hitsPerPage])).toEqual(
        requests.map(() => ['(nsfwLevel=1)', 6])
      );
    });
  });
});
