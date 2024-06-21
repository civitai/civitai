import { MultiSelectWrapper } from '~/libs/form/components/MultiSelectWrapper';
import { SelectWrapper } from '~/libs/form/components/SelectWrapper';
import { trpc } from '~/utils/trpc';

export function ToolMultiSelect({
  value,
  onChange,
  placeholder = 'select...',
}: {
  value: number[];
  onChange: (value: number[]) => void;
  placeholder?: string;
}) {
  const { data = [], isLoading } = trpc.tool.getAll.useQuery();

  return (
    <MultiSelectWrapper
      value={value}
      onChange={onChange}
      loading={isLoading}
      placeholder={placeholder}
      data={data.map(({ id, name, type }) => ({ value: id, label: name, group: type }))}
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
  const { data = [], isLoading } = trpc.tool.getAll.useQuery();

  return (
    <SelectWrapper
      value={value}
      onChange={onChange}
      loading={isLoading}
      placeholder={placeholder}
      data={data.map(({ id, name, type }) => ({ value: id, label: name, group: type }))}
      searchable
      clearable
    />
  );
}
