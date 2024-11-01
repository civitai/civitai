import { Field, Label, Radio, RadioGroup } from '@headlessui/react';

type RadioGroupWrapperProps<T> = {
  value?: T;
  defaultValue?: T;
  onChange?(value: T): void;
  options: { label: React.ReactNode; value: T }[];
};

export function CustomRadioGroup<T extends string | number>({
  value,
  defaultValue,
  onChange,
  options,
}: RadioGroupWrapperProps<T>) {
  return (
    <RadioGroup value={value} defaultValue={defaultValue} onChange={onChange}>
      {options.map(({ label, value }) => (
        <Field key={value} className="flex items-center gap-2">
          <Radio
            value={value}
            className="group flex size-3 items-center justify-center rounded-full border bg-white data-[checked]:bg-blue-400"
          >
            <span className="invisible size-1 rounded-full bg-white group-data-[checked]:visible" />
          </Radio>
          <Label>{label}</Label>
        </Field>
      ))}
    </RadioGroup>
  );
}
