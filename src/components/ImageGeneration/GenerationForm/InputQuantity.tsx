import { NumberInput, NumberInputProps } from '@mantine/core';
import { useDidUpdate } from '@mantine/hooks';
import { useEffect, useState } from 'react';
import {
  useGenerationFormStore,
  useGenerationStatus,
} from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { NumberInputWrapper } from '~/libs/form/components/NumberInputWrapper';
import { withController } from '~/libs/form/hoc/withController';

type Props = Omit<NumberInputProps, 'limit' | 'min' | 'max'> & {
  format?: 'default' | 'delimited' | 'currency';
  clearable?: boolean;
  onClear?: () => void;
  currency?: string;
};

function QuantityInput({ value, onChange, ...inputWrapperProps }: Props) {
  const draft = useGenerationFormStore((x) => x.draft);
  const { limits } = useGenerationStatus();

  useDidUpdate(() => {
    if ((value ?? 0) > limits.quantity) {
      onValueChanged(value);
    }
  }, [value]);

  useEffect(() => {
    if (!!value && draft && value % 4 !== 0) {
      onValueChanged(value);
    }
  }, [draft]);

  const onValueChanged = (newValue: number | undefined) => {
    if (newValue === undefined) {
      newValue = 0;
    }

    if (newValue > limits.quantity) {
      newValue = limits.quantity;
    }

    if (draft && newValue % 4 !== 0) {
      const draftValue = Math.ceil(newValue / 4) * 4;
      if (draftValue > limits.quantity) {
        newValue = Math.floor(newValue / 4) * 4;
      } else {
        newValue = draftValue;
      }
    }

    onChange?.(newValue);
  };

  return (
    <NumberInput
      value={value}
      onChange={onValueChanged}
      {...inputWrapperProps}
      min={!!draft ? 4 : 1}
      max={!!draft ? Math.floor(limits.quantity / 4) * 4 : limits.quantity}
      step={!!draft ? 4 : 1}
    />
  );
}

const InputQuantity = withController(QuantityInput, ({ field }) => ({
  value: field.value,
}));
export default InputQuantity;
