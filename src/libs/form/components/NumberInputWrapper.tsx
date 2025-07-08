import type { NumberInputProps } from '@mantine/core';
import { CloseButton, NumberInput, Text } from '@mantine/core';
import { useMergedRef } from '@mantine/hooks';
import { forwardRef, useEffect, useRef } from 'react';
import { constants } from '~/server/common/constants';

type Props = Omit<NumberInputProps, 'onChange'> & {
  format?: 'default' | 'delimited' | 'currency';
  clearable?: boolean;
  onClear?: () => void;
  currency?: string;
  onChange?: (value: number | undefined) => void;
};

export const NumberInputWrapper = forwardRef<HTMLInputElement, Props>(
  (
    {
      format = 'delimited',
      clearable,
      onClear,
      onChange,
      value,
      currency = constants.defaultCurrency,
      min,
      max,
      step,
      ...props
    },
    ref
  ) => {
    const inputRef = useRef<HTMLInputElement>(null);
    const mergedRef = useMergedRef(ref, inputRef);

    const handleClearInput = () => {
      if (!inputRef.current) return;

      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )?.set;
      nativeInputValueSetter?.call(inputRef.current, '');

      const ev2 = new Event('input', { bubbles: true });
      inputRef.current.dispatchEvent(ev2);
    };

    useEffect(() => {
      if (value === undefined || typeof value !== 'number') handleClearInput();
    }, [value]); //eslint-disable-line

    const isCurrency = format === 'currency';
    const handleChange = (value: number | string) => {
      // If value is empty string, treat as null for form state
      onChange?.(
        typeof value === 'number' ? (isCurrency ? Math.ceil(value * 100) : value) : undefined
      );
    };

    const showCloseButton = clearable && (typeof value === 'number' || !!value);
    const closeButton = (
      <CloseButton
        radius="xl"
        color="gray"
        size="xs"
        variant="filled"
        mr={3}
        onClick={() => {
          handleClearInput();
          onClear?.();
          onChange?.(undefined);
        }}
      />
    );

    // If value is empty string, treat as null for rendering
    const normalizedValue = value === '' ? null : value;
    const parsedValue =
      typeof normalizedValue === 'number'
        ? isCurrency
          ? normalizedValue / 100
          : normalizedValue
        : undefined;

    return (
      <NumberInput
        ref={mergedRef}
        thousandSeparator={format !== 'default'}
        rightSection={
          isCurrency ? <Text size="xs">{currency}</Text> : showCloseButton ? closeButton : null
        }
        rightSectionWidth={isCurrency ? 45 : undefined}
        decimalScale={isCurrency ? 2 : undefined}
        fixedDecimalScale={isCurrency}
        onChange={handleChange}
        value={parsedValue}
        min={min ? (isCurrency ? min / 100 : min) : undefined}
        max={max ? (isCurrency ? max / 100 : max) : undefined}
        step={step ? (isCurrency ? step / 100 : step) : undefined}
        {...props}
      />
    );
  }
);

NumberInputWrapper.displayName = 'NumberInputWrapper';
