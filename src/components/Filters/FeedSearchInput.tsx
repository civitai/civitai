import { CloseButton, TextInput } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { normalizeFeedQuery } from '~/components/Image/Infinite/image-feed-search';

/** The feed's `query` param, normalized, or undefined. */
export const useFeedSearchQuery = () => {
  const { query } = useRouter();
  return normalizeFeedQuery(typeof query.query === 'string' ? query.query : undefined);
};

/**
 * A feed's text search, kept in the page's `query` param. Like the header bar (useFeedSearchSync),
 * it writes the URL only on Enter, blur or clear, never as you type: each applied query is a
 * semantic search.
 */
export function FeedSearchInput({ placeholder }: { placeholder: string }) {
  const router = useRouter();
  const current = useFeedSearchQuery();
  const [value, setValue] = useState(current ?? '');
  // Back, a shared link or another control changed the query: show it.
  useEffect(() => setValue(current ?? ''), [current]);

  const commit = (text: string) => {
    const query = normalizeFeedQuery(text);
    if (query === current) return;
    const { query: _drop, ...rest } = router.query;
    void router.push(
      { pathname: router.pathname, query: query ? { ...rest, query } : rest },
      undefined,
      { shallow: true }
    );
  };

  return (
    <TextInput
      size="xs"
      radius="xl"
      w={200}
      placeholder={placeholder}
      aria-label={placeholder}
      leftSection={<IconSearch size={14} />}
      rightSection={
        value ? (
          <CloseButton
            size="xs"
            aria-label="Clear search"
            onClick={() => {
              setValue('');
              commit('');
            }}
          />
        ) : null
      }
      value={value}
      onChange={(e) => setValue(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit(value);
      }}
      onBlur={() => commit(value)}
    />
  );
}
