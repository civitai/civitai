import { CloseButton, TextInput } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import { forwardRef, useImperativeHandle, useRef } from 'react';
import { useFeedSearchText } from '~/components/Filters/FeedSearchInput';

type Props = {
  placeholder: string;
  className?: string;
  variant?: string;
  onClear?: VoidFunction;
  onSubmit?: VoidFunction;
};

/**
 * The header bar on a page that searches its own content (`pageSearchFor`): a plain box for the
 * page's `?query=`, applied on Enter, blur or clear, with no index selector or dropdown.
 */
export const PageSearchBar = forwardRef<{ focus: () => void }, Props>(
  ({ placeholder, className, variant, onClear, onSubmit }, ref) => {
    const { value, setValue, commit } = useFeedSearchText();
    const inputRef = useRef<HTMLInputElement>(null);
    useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }));

    return (
      <TextInput
        ref={inputRef}
        className={className}
        variant={variant}
        type="search"
        placeholder={placeholder}
        aria-label={placeholder}
        leftSection={<IconSearch size={16} />}
        rightSection={
          value ? (
            <CloseButton
              size="sm"
              aria-label="Clear search"
              onClick={() => {
                setValue('');
                commit('');
                onClear?.();
              }}
            />
          ) : null
        }
        value={value}
        onChange={(event) => setValue(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          commit(value);
          inputRef.current?.blur();
          onSubmit?.();
        }}
        onBlur={() => commit(value)}
      />
    );
  }
);
PageSearchBar.displayName = 'PageSearchBar';
