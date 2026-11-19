import { Input } from '@mantine/core';
import { ChoiceGroup } from '~/libs/form/components/ChoiceGroup';
import { FieldCorrectionNote } from '../FieldCorrectionNote';

export type SegmentedEnumMeta = { options: readonly { label: string; value: string }[] };

export function SegmentedEnumField<T extends string>({
  label,
  value,
  onChange,
  options,
  note,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: SegmentedEnumMeta['options'];
  note?: React.ComponentProps<typeof FieldCorrectionNote>['note'];
}) {
  return (
    <div className="flex flex-col gap-1">
      <Input.Label>{label}</Input.Label>
      <ChoiceGroup
        value={value}
        onChange={(v) => onChange(v as T)}
        data={options.map((o) => ({ label: o.label, value: o.value }))}
      />
      <FieldCorrectionNote note={note} />
    </div>
  );
}
