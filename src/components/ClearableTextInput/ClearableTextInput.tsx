import { CloseButton, Group, TextInput, TextInputProps } from '@mantine/core';
import { useMergedRef } from '@mantine/hooks';
import { forwardRef, useRef } from 'react';

type ClearableTextInputProps = TextInputProps & {
  clearable?: boolean;
  onClear?: () => void;
};

export const ClearableTextInput = forwardRef<HTMLInputElement, ClearableTextInputProps>(
  ({ clearable = true, rightSection, onClear, ...props }, ref) => {
    const inputRef = useRef<HTMLInputElement>(null);
    const mergedRef = useMergedRef(ref, inputRef);

    const closeButton = props.value && (
      <CloseButton
        variant="transparent"
        onClick={() => {
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            'value'
          )?.set;
          nativeInputValueSetter?.call(inputRef.current, '');

          const ev2 = new Event('input', { bubbles: true });
          inputRef.current?.dispatchEvent(ev2);
          onClear?.();
        }}
      />
    );
    return (
      <TextInput
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

ClearableTextInput.displayName = 'ClearableTextInput';

// export function ClearableTextInput({
//   clearable = true,
//   rightSection,
//   onClear,
//   ...props
// }: ClearableTextInputProps) {
//   const ref = useRef<HTMLInputElement>(null);

//   const closeButton = props.value && (
//     <CloseButton
//       variant="transparent"
//       onClick={() => {
//         const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
//           window.HTMLInputElement.prototype,
//           'value'
//         )?.set;
//         nativeInputValueSetter?.call(ref.current, '');

//         const ev2 = new Event('input', { bubbles: true });
//         ref.current?.dispatchEvent(ev2);
//         onClear?.();
//       }}
//     />
//   );
//   return (
//     <TextInput
//       ref={ref}
//       {...props}
//       rightSection={
//         (clearable || rightSection) && (
//           <Group spacing={4} noWrap>
//             {clearable && closeButton}
//             {rightSection}
//           </Group>
//         )
//       }
//     />
//   );
// }
