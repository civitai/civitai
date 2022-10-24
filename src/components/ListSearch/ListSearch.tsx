import { TextInput } from '@mantine/core';
import { useModelStore } from '~/hooks/useModelStore';
import { useState } from 'react';

export function ListSearch() {
  const [value, setValue] = useState('');

  const tags = useModelStore((state) => state.filters.tags);
  const query = useModelStore((state) => state.filters.query);
  const users = useModelStore((state) => state.filters.users);

  const setTags = useModelStore((state) => state.setTags);
  const setQuery = useModelStore((state) => state.setQuery);
  const setUsers = useModelStore((state) => state.setUsers);

  return (
    <>
      <TextInput value={query} onChange={(e) => setQuery(e.target.value)} />
    </>
  );
}
