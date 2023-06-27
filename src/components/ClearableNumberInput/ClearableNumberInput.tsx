import { CloseButton, Group, NumberInput, NumberInputProps } from '@mantine/core';
import { useMergedRef } from '@mantine/hooks';
import { forwardRef, useRef } from 'react';
import { withController } from '~/libs/form/hoc/withController';

type ClearableTextInputProps = NumberInputProps & {
  clearable?: boolean;
  onClear?: () => void;
};

const ClearableNumberInput = forwardRef<HTMLInputElement, ClearableTextInputProps>(
  ({ clearable = true, rightSection, onClear, ...props }, ref) => {
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
          props.onChange?.(undefined);
        }}
      />
    );
    return (
      <NumberInput
        ref={mergedRef}
        {...props}
        rightSection={
          (clearable || rightSection) && (
            <Group spacing={4} noWrap>
              {clearable && closeButton}
              {rightSection}
            </Group>
          )
        }
      />
    );
  }
);

ClearableNumberInput.displayName = 'ClearableNumberInput';
export const InputNumberClearable = withController(ClearableNumberInput);
