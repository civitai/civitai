import { CloseButton, NumberInput, NumberInputProps, Text } from '@mantine/core';
import { useMergedRef } from '@mantine/hooks';
import { forwardRef, useEffect, useMemo, useRef } from 'react';
import { numberWithCommas } from '~/utils/number-helpers';
import { constants } from '~/server/common/constants';

type Props = NumberInputProps & {
  format?: 'default' | 'delimited' | 'currency';
  clearable?: boolean;
  onClear?: () => void;
  currency?: string;
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
      if (value === undefined) handleClearInput();
    }, [value]); //eslint-disable-line

    const handleChange = (value: number | undefined) => {
      onChange?.(value);
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

    const { parser, formatter } = useMemo(() => {
      switch (format) {
        case 'delimited':
          return {
            parser: (value?: string) => value && value.replace(/\$\s?|(,*)/g, ''),
            formatter: (value?: string) => numberWithCommas(value),
          };
        case 'currency':
          return {
            parser: (value?: string) => {
              if (!value) {
                return '';
              }

              const number = value
                // Technically, we can go ahead with a single replace/regexp, but this is more readable.
                .replace(/\$\s?|(,*)/g, '') // Remove the commas & spaces
                .replace('.', ''); // Remove the periods.
              const int = parseInt(number);

              return isNaN(int) ? '' : int.toString();
            },
            formatter: (value?: string) => {
              if (!value) {
                return '';
              }

              const int = parseInt(value);

              if (isNaN(int)) {
                return '';
              }

              const [intPart, decimalPart] = (int / 100).toFixed(2).split('.');

              return `${numberWithCommas(intPart)}.${decimalPart}`;
            },
          };
        default: {
          return {
            parser: undefined,
            formatter: undefined,
          };
        }
      }
    }, [format]);

    return (
      <NumberInput
        ref={mergedRef}
        parser={parser}
        formatter={formatter}
        rightSection={
          format === 'currency' ? (
            <Text size="xs">{currency}</Text>
          ) : showCloseButton ? (
            closeButton
          ) : null
        }
        rightSectionWidth={format === 'currency' ? 45 : undefined}
        onChange={handleChange}
        value={value}
        {...props}
      />
    );
  }
);

NumberInputWrapper.displayName = 'NumberInputWrapper';
