import { Autocomplete, AutocompleteProps, CloseButton } from '@mantine/core';
import { useMergedRef } from '@mantine/hooks';
import { forwardRef, useRef } from 'react';

export const ClearableAutoComplete = forwardRef<HTMLInputElement, Props>(
  ({ clearable = false, onClear, ...props }, ref) => {
    const inputRef = useRef<HTMLInputElement>(null);
    const mergedRef = useMergedRef(inputRef, ref);

    const closeButton = props.value && (
      <CloseButton
        variant="transparent"
        onClick={() => {
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            'value'
          )?.set;
          nativeInputValueSetter?.call(inputRef.current, '');

          const innerEvent = new Event('input', { bubbles: true });
          inputRef.current?.dispatchEvent(innerEvent);
          onClear?.();
        }}
      />
    );

    return (
      <Autocomplete ref={mergedRef} {...props} rightSection={clearable ? closeButton : null} />
    );
  }
);
ClearableAutoComplete.displayName = 'ClearableAutoComplete';

type Props = Omit<AutocompleteProps, 'rightSection'> & {
  clearable?: boolean;
  onClear?: () => void;
};
