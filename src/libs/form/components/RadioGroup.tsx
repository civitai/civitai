import { Radio as HeadlessRadio, RadioGroup as HeadlessRadioGroup } from '@headlessui/react';
import clsx from 'clsx';

export const Radio = {
  Group: HeadlessRadioGroup,
  Item: RadioItem,
};

function RadioItem({
  value,
  label,
  disabled,
}: {
  value: any;
  label: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <HeadlessRadio
      value={value}
      disabled={disabled}
      className={clsx(
        !disabled ? 'cursor-pointer focus:outline-none' : 'cursor-not-allowed opacity-25',
        'flex flex-1 items-center justify-center rounded-md  p-3 text-sm font-semibold ring-1  data-[checked]:text-white   data-[checked]:ring-0 data-[focus]:data-[checked]:ring-2 data-[focus]:ring-2 data-[focus]:ring-offset-2  sm:flex-1  [&:not([data-focus])]:[&:not([data-checked])]:ring-inset  ',
        'bg-white text-dark-9 ring-gray-4 hover:bg-gray-1 data-[checked]:bg-blue-5 data-[focus]:ring-blue-5 ',
        'dark:bg-dark-5 dark:text-white dark:ring-dark-4 dark:hover:bg-dark-4 dark:data-[checked]:bg-blue-8 dark:data-[focus]:ring-blue-8 '
      )}
    >
      {label}
    </HeadlessRadio>
  );
}
