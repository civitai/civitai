import { CloseButton, NumberInput, NumberInputProps } from '@mantine/core';
import { useMergedRef, usePrevious } from '@mantine/hooks';
import { forwardRef, useEffect, useMemo, useRef } from 'react';
import { numberWithCommas } from '~/utils/number-helpers';

type Props = NumberInputProps & {
  format?: 'default' | 'delimited';
  clearable?: boolean;
  onClear?: () => void;
};

export const NumberInputWrapper = forwardRef<HTMLInputElement, Props>(
  ({ format = 'delimited', clearable, rightSection, onClear, onChange, ...props }, ref) => {
    const inputRef = useRef<HTMLInputElement>(null);
    const mergedRef = useMergedRef(ref, inputRef);
    const canReset = useRef(true);

    const handleClearInput = () => {
      if (!inputRef.current) return;

      const event = new Event('input', { bubbles: true });
      inputRef.current.value = null as any;
      inputRef.current.dispatchEvent(event);

      onClear?.();
      onChange?.(undefined);

      // const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      //   window.HTMLInputElement.prototype,
      //   'value'
      // )?.set;
      // nativeInputValueSetter?.call(inputRef.current, '');

      // const ev2 = new Event('input', { bubbles: true });
      // inputRef.current.dispatchEvent(ev2);
    };

    // const previousValue = usePrevious(props.value);
    useEffect(() => {
      if (props.value === null) {
        console.log('reset');
        handleClearInput();
      }
    }, [props.value]) //eslint-disable-line

    const handleChange = (value: number | undefined) => {
      canReset.current = true;
      onChange?.(value);
    };

    const closeButton = props.value && (
      <CloseButton
        radius="xl"
        color="gray"
        size="xs"
        variant="filled"
        mr={3}
        onClick={() => {
          handleClearInput();
          // onClear?.();
          // onChange?.(undefined);
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
        onChange={handleChange}
        {...props}
      />
    );
  }
);

NumberInputWrapper.displayName = 'NumberInputWrapper';
