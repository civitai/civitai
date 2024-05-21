import { MultiSelectWrapper } from '~/libs/form/components/MultiSelectWrapper';
import { trpc } from '~/utils/trpc';

export function ToolMultiSelect({
  value,
  onChange,
}: {
  value: number[];
  onChange: (value: number[]) => void;
}) {
  const { data = [], isLoading } = trpc.tool.getAll.useQuery();

  return (
    <MultiSelectWrapper
      value={value}
      onChange={onChange}
      loading={isLoading}
      placeholder="select..."
      data={data.map(({ id, name, type }) => ({ value: id, label: name, group: type }))}
    />
  );
}
