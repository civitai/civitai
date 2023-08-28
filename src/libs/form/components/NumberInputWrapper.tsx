import { CloseButton, NumberInput, NumberInputProps } from '@mantine/core';
import { useMergedRef } from '@mantine/hooks';
import { forwardRef, useEffect, useMemo, useRef } from 'react';
import { numberWithCommas } from '~/utils/number-helpers';

type Props = NumberInputProps & {
  format?: 'default' | 'delimited';
  clearable?: boolean;
  onClear?: () => void;
};

export const NumberInputWrapper = forwardRef<HTMLInputElement, Props>(
  ({ format = 'delimited', clearable, rightSection, onClear, onChange, value, ...props }, ref) => {
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
        rightSection={showCloseButton ? closeButton : rightSection}
        onChange={handleChange}
        value={value}
        {...props}
      />
    );
  }
);

NumberInputWrapper.displayName = 'NumberInputWrapper';
