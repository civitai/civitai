import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
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

// Every request is asserted, not only the settled one: a request that carried the filter without
// `hitsPerPage` would still settle on the right values and read as green.
describe('ApplyCustomFilter', () => {
  it('keeps its other Configure params on every request it drives', async () => {
    const { requests, searchClient } = createRecordingClient();

    render(
      <InstantSearch searchClient={searchClient as never} indexName="models_v9">
        <ApplyCustomFilter filters={['nsfwLevel=1']} hitsPerPage={6} />
      </InstantSearch>
    );

    await vi.waitFor(() => {
      expect(requests.length).toBeGreaterThanOrEqual(1);
      expect(requests.map((r) => [r.params?.filters, r.params?.hitsPerPage])).toEqual(
        requests.map(() => ['(nsfwLevel=1)', 6])
      );
    });
  });

  // The widget re-registers with its full props when they change, so a manual `refine` on top of
  // `useConfigure` only re-issues a search someone already asked for. Measured against production:
  // it tripled a /search page load, 2 requests to 6.
  it('drives one search per distinct filter, not two', async () => {
    const { requests, searchClient } = createRecordingClient();
    let setFilter: ((filter: string) => void) | undefined;

    function Harness() {
      const [filter, set] = useState('nsfwLevel=1');
      setFilter = set;

      return (
        <InstantSearch searchClient={searchClient as never} indexName="models_v9">
          <ApplyCustomFilter filters={[filter]} hitsPerPage={6} />
        </InstantSearch>
      );
    }

    render(<Harness />);

    await vi.waitFor(() => expect(requests.length).toBeGreaterThanOrEqual(1));

    setFilter?.('nsfwLevel=1 OR nsfwLevel=2');

    await vi.waitFor(() =>
      expect(requests.at(-1)?.params?.filters).toBe('(nsfwLevel=1 OR nsfwLevel=2)')
    );

    expect(requests.map((r) => r.params?.filters)).toEqual([
      '(nsfwLevel=1)',
      '(nsfwLevel=1 OR nsfwLevel=2)',
    ]);
  });
});
