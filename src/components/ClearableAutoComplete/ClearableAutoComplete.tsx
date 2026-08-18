import type { AutocompleteProps } from '@mantine/core';
import { Autocomplete, CloseButton, Loader } from '@mantine/core';
import { useMergedRef } from '@mantine/hooks';
import { forwardRef, useRef } from 'react';

export const ClearableAutoComplete = forwardRef<HTMLInputElement, Props>(
  ({ clearable = false, loading = false, onClear, rightSection, ...props }, ref) => {
    const inputRef = useRef<HTMLInputElement>(null);
    const mergedRef = useMergedRef(inputRef, ref);

    const closeButton = onClear && (
      <CloseButton
        variant="transparent"
        title="clear search"
        onClick={() => {
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            'value'
          )?.set;
          nativeInputValueSetter?.call(inputRef.current, '');

          const innerEvent = new Event('input', { bubbles: false });
          inputRef.current?.dispatchEvent(innerEvent);
          onClear();
        }}
      />
    );

    return (
      <Autocomplete
        ref={mergedRef}
        {...props}
        // Takes the slot from the clear button while a search is in flight: an empty dropdown and
        // an idle-looking input are indistinguishable from "no results".
        rightSection={loading ? <Loader size="xs" /> : clearable ? closeButton : rightSection}
      />
    );
  }
);
ClearableAutoComplete.displayName = 'ClearableAutoComplete';

type Props = AutocompleteProps & {
  clearable?: boolean;
  loading?: boolean;
  onClear?: () => void;
  className?: string;
};
