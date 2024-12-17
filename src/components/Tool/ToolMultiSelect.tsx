import { MultiSelectProps } from '@mantine/core';
import { useQueryTools } from '~/components/Tool/tools.utils';
import { MultiSelectWrapper } from '~/libs/form/components/MultiSelectWrapper';
import { SelectWrapper } from '~/libs/form/components/SelectWrapper';

export function ToolMultiSelect({
  value,
  onChange,
  placeholder = 'select...',
  ...selectProps
}: Omit<MultiSelectProps, 'data' | 'onChange' | 'value' | 'defaultValue'> & {
  value: number[];
  onChange: (value: number[]) => void;
}) {
  const { tools, loading } = useQueryTools({ filters: { include: ['unlisted'] } });

  return (
    <MultiSelectWrapper
      {...selectProps}
      value={value}
      onChange={onChange}
      loading={loading}
      placeholder={placeholder}
      data={tools.map(({ id, name, type }) => ({ value: id, label: name, group: type }))}
      searchable
      clearable
    />
  );
}

export function ToolSelect({
  value,
  onChange,
  placeholder = 'select...',
}: {
  value: number;
  onChange: (value: number) => void;
  placeholder?: string;
}) {
  const { tools, loading } = useQueryTools({ filters: { include: ['unlisted'] } });

  return (
    <SelectWrapper
      value={value}
      onChange={onChange}
      loading={loading}
      placeholder={placeholder}
      data={tools.map(({ id, name, type }) => ({ value: id, label: name, group: type }))}
      searchable
      clearable
      withinPortal
    />
  );
}
