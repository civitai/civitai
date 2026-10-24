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
  /** A value typed past `max` becomes `max` right away, instead of staying until blur. */
  clampToMax?: boolean;
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
      clampToMax,
      isAllowed,
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

    // Rejecting the keystroke while reporting `max` keeps the text in step with the value: once the
    // value is already `max`, a second clamp to `max` wouldn't re-render the input.
    const handleIsAllowed: NumberInputProps['isAllowed'] = (values) => {
      if (isAllowed && !isAllowed(values)) return false;
      const displayMax = typeof max === 'number' ? (isCurrency ? max / 100 : max) : undefined;
      if (clampToMax && displayMax !== undefined && (values.floatValue ?? 0) > displayMax) {
        handleChange(displayMax);
        return false;
      }
      return true;
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
        isAllowed={handleIsAllowed}
        value={parsedValue}
        min={min != null ? (isCurrency ? min / 100 : min) : undefined}
        max={max != null ? (isCurrency ? max / 100 : max) : undefined}
        step={step != null ? (isCurrency ? step / 100 : step) : undefined}
        {...props}
      />
    );
  }
);

NumberInputWrapper.displayName = 'NumberInputWrapper';
