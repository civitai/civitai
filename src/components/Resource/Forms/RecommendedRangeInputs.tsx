import { Group } from '@mantine/core';
import { useFormContext, useWatch } from 'react-hook-form';
import { InputNumber } from '~/libs/form';

type Props = {
  /** The form path of the range object, e.g. `settings.turbo.steps`. */
  name: string;
  label: string;
  required?: boolean;
  min: number;
  max: number;
  step?: number;
  decimalScale?: number;
};

/**
 * Min, max and default for one recommended range, in that order. Each input is bounded by its
 * neighbours so the three cannot be saved inverted; the schema refinement is the backstop.
 */
export function RecommendedRangeInputs({
  name,
  label,
  required,
  min,
  max,
  step,
  decimalScale,
}: Props) {
  const { control } = useFormContext();
  const [rangeMin, rangeMax] = useWatch({ control, name: [`${name}.min`, `${name}.max`] }) as [
    number | undefined,
    number | undefined
  ];
  const shared = { step, decimalScale, required };
  return (
    <Group w="100%" align="start" grow>
      <InputNumber
        name={`${name}.min`}
        label={`${label} min`}
        min={min}
        max={rangeMax ?? max}
        {...shared}
      />
      <InputNumber
        name={`${name}.max`}
        label={`${label} max`}
        min={rangeMin ?? min}
        max={max}
        {...shared}
      />
      <InputNumber
        name={`${name}.default`}
        label={label}
        min={rangeMin ?? min}
        max={rangeMax ?? max}
        {...shared}
      />
    </Group>
  );
}
