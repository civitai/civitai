import { CloseButton, TextInput } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { nextFeedSearchQuery } from '~/components/AutocompleteSearch/autocomplete-query';
import { normalizeFeedQuery } from '~/components/Image/Infinite/image-feed-search';

/** The feed's `query` param, normalized, or undefined. */
export const useFeedSearchQuery = () => {
  const { query } = useRouter();
  return normalizeFeedQuery(typeof query.query === 'string' ? query.query : undefined);
};

/**
 * The text of a box that edits the page's `query` param: committed (a history entry) only on
 * Enter, blur or clear, and following the URL when Back, a link or another control changes it.
 */
export function useFeedSearchText() {
  const router = useRouter();
  const current = useFeedSearchQuery();
  const [value, setValue] = useState(current ?? '');
  useEffect(() => setValue(current ?? ''), [current]);

  const commit = (text: string) => {
    const next = nextFeedSearchQuery(router.query, text);
    if (next)
      void router.push({ pathname: router.pathname, query: next }, undefined, { shallow: true });
  };
  return { value, setValue, commit };
}

/** A feed's text search box, kept in the page's `query` param (see `useFeedSearchText`). */
export function FeedSearchInput({ placeholder }: { placeholder: string }) {
  const { value, setValue, commit } = useFeedSearchText();

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
