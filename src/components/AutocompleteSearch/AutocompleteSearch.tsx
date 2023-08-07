import { autocomplete, AutocompleteOptions } from '@algolia/autocomplete-js';
import {
  getMeilisearchResults,
  meilisearchAutocompleteClient,
} from '@meilisearch/autocomplete-client';
import { useEffect, useRef, useState } from 'react';
import { usePagination, useSearchBox } from 'react-instantsearch-hooks-web';
import { env } from '~/env/client.mjs';
import { ClearableAutoComplete } from '../ClearableAutoComplete/ClearableAutoComplete';

const searchClient = meilisearchAutocompleteClient({
  url: env.NEXT_PUBLIC_SEARCH_HOST as string,
  apiKey: env.NEXT_PUBLIC_SEARCH_CLIENT_KEY,
  options: { primaryKey: 'id' },
});

type Props = Partial<AutocompleteOptions<any>> & {
  className?: string;
};

export function AutocompleteSearch({ className, ...autocompleteProps }: Props) {
  const autocompleteContainer = useRef<HTMLInputElement>(null);

  const { query, refine: setQuery } = useSearchBox();
  const { refine: setPage } = usePagination();

  const [instantSearchUiState, setInstantSearchUiState] = useState<{ query: string }>({ query });

  useEffect(() => {
    setQuery(instantSearchUiState.query);
    setPage(0);
  }, [instantSearchUiState, setPage, setQuery]);

  useEffect(() => {
    if (!autocompleteContainer.current) {
      return;
    }

    const autocompleteInstance = autocomplete({
      ...autocompleteProps,
      container: autocompleteContainer.current,
      initialState: { query },
      onReset() {
        setInstantSearchUiState({ query: '' });
      },
      onSubmit({ state }) {
        setInstantSearchUiState({ query: state.query });
      },
      onStateChange({ prevState, state }) {
        if (prevState.query !== state.query) {
          setInstantSearchUiState({
            query: state.query,
          });
        }
      },
      getSources({ query }) {
        return [
          {
            sourceId: 'steam-video-games',
            getItems() {
              return getMeilisearchResults({
                searchClient,
                queries: [{ indexName: 'models', query }],
              });
            },
            templates: {
              item({ item, components, html }) {
                return html`<div>
                  <div>${item.name}</div>
                </div>`;
              },
            },
          },
        ];
      },
    });

    return () => autocompleteInstance.destroy();
  }, [autocompleteProps, query]);

  return <div ref={autocompleteContainer} className={className} />;
}
