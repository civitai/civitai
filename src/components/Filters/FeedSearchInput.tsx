import { CloseButton, TextInput } from '@mantine/core';
import { useDebouncedCallback } from '@mantine/hooks';
import { IconSearch } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useState } from 'react';

/** A feed's text search, kept in the page's `query` param. */
export function FeedSearchInput({ placeholder }: { placeholder: string }) {
  const router = useRouter();
  const current = typeof router.query.query === 'string' ? router.query.query : '';
  const [value, setValue] = useState(current);
  const commit = useDebouncedCallback((next: string) => {
    const { query: _drop, ...rest } = router.query;
    const query = next.trim();
    router.replace(
      { pathname: router.pathname, query: query ? { ...rest, query } : rest },
      undefined,
      { shallow: true }
    );
  }, 400);

  const change = (next: string) => {
    setValue(next);
    commit(next);
  };
  return (
    <TextInput
      size="xs"
      radius="xl"
      w={200}
      placeholder={placeholder}
      aria-label={placeholder}
      leftSection={<IconSearch size={14} />}
      rightSection={value ? <CloseButton size="xs" onClick={() => change('')} /> : null}
      value={value}
      onChange={(e) => change(e.currentTarget.value)}
    />
  );
}

/** The feed's `query` param, or undefined. */
export const useFeedSearchQuery = () => {
  const { query } = useRouter();
  return typeof query.query === 'string' && query.query.trim() ? query.query : undefined;
};
