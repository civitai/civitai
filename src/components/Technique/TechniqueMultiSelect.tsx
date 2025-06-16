import type { MultiSelectProps } from '@mantine/core';
import { MultiSelectWrapper } from '~/libs/form/components/MultiSelectWrapper';
import { trpc } from '~/utils/trpc';

export function TechniqueMultiSelect({
  value,
  onChange,
  placeholder = 'select...',
  ...selectProps
}: Omit<MultiSelectProps, 'data' | 'onChange' | 'value' | 'defaultValue'> & {
  value: number[];
  onChange: (value: number[]) => void;
  placeholder?: string;
}) {
  const { data = [], isLoading } = trpc.technique.getAll.useQuery();

  return (
    <MultiSelectWrapper
      {...selectProps}
      value={value}
      onChange={onChange}
      loading={isLoading}
      placeholder={placeholder}
      data={data.map(({ id, name }) => ({ value: id, label: name }))}
      searchable
      clearable
    />
  );
}
