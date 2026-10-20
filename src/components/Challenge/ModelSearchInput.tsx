import { Autocomplete, Loader } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconSearch, IconX } from '@tabler/icons-react';
import { useState, useEffect } from 'react';
import { env } from '~/env/client';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { searchFetch } from '~/components/Search/search-api-key';
import { searchIndexMap } from '~/components/Search/search.types';

type ModelSearchResult = {
  id: number;
  name: string;
  user: { username: string };
};

type ModelSearchHit = { id: number; name: string; user?: { username?: string } };

function searchModelsIndex(params: { q?: string; filter?: string; limit: number }) {
  return searchFetch<{ hits: ModelSearchHit[] }>(
    `${env.NEXT_PUBLIC_SEARCH_HOST}/indexes/${searchIndexMap.models}/search`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...params, attributesToRetrieve: ['id', 'name', 'user'] }),
    }
  );
}

type Props = {
  value: number | null | undefined;
  onChange: (modelId: number | null) => void;
  error?: string;
};

/**
 * Model search input using Meilisearch for efficient searching.
 * This avoids hitting the database directly for model searches.
 */
export function ModelSearchInput({ value, onChange, error }: Props) {
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery] = useDebouncedValue(searchQuery, 300);
  const [results, setResults] = useState<ModelSearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedModel, setSelectedModel] = useState<ModelSearchResult | null>(null);

  // Fetch model details if value is provided (for edit mode)
  useEffect(() => {
    if (value && !selectedModel) {
      fetchModelById(value);
    }
  }, [value]);

  // Search models when query changes
  useEffect(() => {
    if (debouncedQuery.length >= 2) {
      searchModels(debouncedQuery);
    } else {
      setResults([]);
    }
  }, [debouncedQuery]);

  const fetchModelById = async (modelId: number) => {
    try {
      // A search by id rather than the documents endpoint: search tokens only grant search.
      const data = await searchModelsIndex({ filter: `id = ${Number(modelId)}`, limit: 1 });
      const model = data.hits[0];
      if (model) {
        setSelectedModel({
          id: model.id,
          name: model.name,
          user: { username: model.user?.username || 'Unknown' },
        });
        setSearchQuery(`${model.name} by ${model.user?.username || 'Unknown'}`);
      }
    } catch (error) {
      console.error('Failed to fetch model:', error);
    }
  };

  const searchModels = async (query: string) => {
    setIsLoading(true);
    try {
      const data = await searchModelsIndex({ q: query, limit: 10 });
      setResults(
        data.hits.map((hit) => ({
          id: hit.id,
          name: hit.name,
          user: { username: hit.user?.username || 'Unknown' },
        }))
      );
    } catch (error) {
      console.error('Model search failed:', error);
      setResults([]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSelect = (value: string) => {
    const selected = results.find(
      (r) => `${r.name} by ${r.user.username}` === value || r.name === value
    );
    if (selected) {
      setSelectedModel(selected);
      setSearchQuery(`${selected.name} by ${selected.user.username}`);
      onChange(selected.id);
    }
  };

  const handleClear = () => {
    setSelectedModel(null);
    setSearchQuery('');
    setResults([]);
    onChange(null);
  };

  const autocompleteData = results.map((r) => ({
    value: `${r.name} by ${r.user.username}`,
    label: r.name,
  }));

  return (
    <Autocomplete
      label="Featured Model"
      placeholder="Search for a model..."
      description="Type at least 2 characters to search"
      value={searchQuery}
      onChange={(value) => {
        setSearchQuery(value);
        // If user clears the input manually, clear the selection
        if (!value) {
          handleClear();
        }
      }}
      onOptionSubmit={handleSelect}
      data={autocompleteData}
      error={error}
      leftSection={<IconSearch size={16} />}
      rightSection={
        isLoading ? (
          <Loader size="xs" />
        ) : selectedModel ? (
          <LegacyActionIcon size="xs" onClick={handleClear} variant="transparent">
            <IconX size={14} />
          </LegacyActionIcon>
        ) : null
      }
      filter={({ options }) => options} // Don't filter - Meilisearch already did
    />
  );
}
