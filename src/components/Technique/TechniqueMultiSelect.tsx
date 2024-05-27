import { MultiSelectWrapper } from '~/libs/form/components/MultiSelectWrapper';
import { trpc } from '~/utils/trpc';

export function TechniqueMultiSelect({
  value,
  onChange,
}: {
  value: number[];
  onChange: (value: number[]) => void;
}) {
  const { data = [], isLoading } = trpc.technique.getAll.useQuery();

  return (
    <MultiSelectWrapper
      value={value}
      onChange={onChange}
      loading={isLoading}
      placeholder="select..."
      data={data.map(({ id, name }) => ({ value: id, label: name }))}
    />
  );
}
