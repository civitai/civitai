import type { NumberInputProps } from '@mantine/core';
import { NumberInput } from '@mantine/core';
import { useDidUpdate } from '@mantine/hooks';
import { withController } from '~/libs/form/hoc/withController';

type Props = Omit<NumberInputProps, 'limit' | 'max' | 'min' | 'step'> & {
  format?: 'default' | 'delimited' | 'currency';
  clearable?: boolean;
  onClear?: () => void;
  currency?: string;
  max: number;
  min: number;
  step: number;
};

function QuantityInput({ value, onChange, min, max, step, ...inputWrapperProps }: Props) {
  useDidUpdate(() => {
    if (!!value && (value > max || value % step !== 0)) {
      onValueChanged(value);
    }
  }, [value, step]);

  const onValueChanged = (newValue: number | undefined) => {
    if (newValue === undefined) newValue = 1;
    if (newValue > max) newValue = max;
    if (newValue % step !== 0) newValue = Math.ceil(newValue / step) * step;
    if (newValue > max) newValue = Math.floor(newValue / step) * step;
    onChange?.(newValue);
  };

  return (
    <NumberInput
      value={value}
      onChange={onValueChanged}
      {...inputWrapperProps}
      min={min}
      max={max}
      step={step}
    />
  );
}

const InputQuantity = withController(QuantityInput, ({ field }) => ({
  value: field.value,
}));
export default InputQuantity;
