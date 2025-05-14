import { MultiSelectProps } from '@mantine/core';
import { useQueryTools } from '~/components/Tool/tools.utils';
import { MultiSelectWrapper } from '~/libs/form/components/MultiSelectWrapper';
import { SelectWrapper } from '~/libs/form/components/SelectWrapper';
import { ToolSort } from '~/server/common/enums';

export function ToolMultiSelect({
  value,
  onChange,
  placeholder = 'select...',
  grouped = true,
  ...selectProps
}: Omit<MultiSelectProps, 'data' | 'onChange' | 'value' | 'defaultValue'> & {
  value: number[];
  onChange: (value: number[]) => void;
  grouped?: boolean;
}) {
  const { tools, loading } = useQueryTools({
    filters: { include: ['unlisted'], sort: ToolSort.AZ },
  });

  return (
    <MultiSelectWrapper
      {...selectProps}
      value={value}
      onChange={onChange}
      loading={loading}
      placeholder={placeholder}
      data={tools.map(({ id, name, type }) =>
        grouped ? { value: id, label: name, group: type } : { value: id, label: name }
      )}
      searchable
      clearable
    />
  );
}

export function ToolSelect({
  value,
  onChange,
  placeholder = 'select...',
  grouped = true,
}: {
  value: number;
  onChange: (value: number) => void;
  placeholder?: string;
  grouped?: boolean;
}) {
  const { tools, loading } = useQueryTools({
    filters: { include: ['unlisted'], sort: ToolSort.AZ },
  });

  return (
    <SelectWrapper
      value={value}
      onChange={onChange}
      loading={loading}
      placeholder={placeholder}
      data={tools.map(({ id, name, type }) =>
        grouped ? { value: id, label: name, group: type } : { value: id, label: name }
      )}
      searchable
      clearable
    />
  );
}
