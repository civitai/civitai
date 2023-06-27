import { CloseButton, NumberInput, NumberInputProps } from '@mantine/core';
import { useMergedRef } from '@mantine/hooks';
import { forwardRef, useMemo, useRef } from 'react';
import { numberWithCommas } from '~/utils/number-helpers';

type Props = NumberInputProps & {
  format?: 'default' | 'delimited';
  clearable?: boolean;
  onClear?: () => void;
};

export const NumberInputWrapper = forwardRef<HTMLInputElement, Props>(
  ({ format = 'delimited', clearable, rightSection, onClear, ...props }, ref) => {
    const inputRef = useRef<HTMLInputElement>(null);
    const mergedRef = useMergedRef(ref, inputRef);

    const closeButton = props.value && (
      <CloseButton
        radius="xl"
        color="gray"
        size="xs"
        variant="filled"
        mr={3}
        onClick={() => {
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            'value'
          )?.set;
          nativeInputValueSetter?.call(inputRef.current, '');

          const ev2 = new Event('input', { bubbles: true });
          inputRef.current?.dispatchEvent(ev2);
          onClear?.();
          props.onChange?.(null as any);
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
        rightSection={clearable && props.value ? closeButton : rightSection}
        {...props}
      />
    );
  }
);

NumberInputWrapper.displayName = 'NumberInputWrapper';
