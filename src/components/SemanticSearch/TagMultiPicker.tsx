import { MultiSelect } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useState } from 'react';
import { TagSort } from '~/server/common/enums';
import { trpc } from '~/utils/trpc';

export type PickedTag = { id: number; name: string };

export function TagMultiPicker({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: PickedTag[];
  onChange: (tags: PickedTag[]) => void;
}) {
  const [search, setSearch] = useState('');
  const [debouncedSearch] = useDebouncedValue(search, 300);
  const { data } = trpc.tag.getAll.useQuery(
    { query: debouncedSearch.trim().toLowerCase(), sort: TagSort.MostImages, limit: 20 },
    { enabled: debouncedSearch.trim().length > 1 }
  );

  const known = new Map(value.map((t) => [String(t.id), t]));
  for (const t of data?.items ?? []) known.set(String(t.id), { id: t.id, name: t.name });

  return (
    <MultiSelect
      label={label}
      placeholder={placeholder}
      data={[...known.values()].map((t) => ({ value: String(t.id), label: t.name }))}
      value={value.map((t) => String(t.id))}
      onChange={(ids) => onChange(ids.map((id) => known.get(id)).filter((t) => !!t))}
      searchValue={search}
      onSearchChange={setSearch}
      searchable
      clearable
      maxValues={20}
    />
  );
}
