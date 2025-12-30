import { Input } from '@mantine/core';
import { IconBolt, IconDiamond } from '@tabler/icons-react';
import clsx from 'clsx';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from '@headlessui/react';
import { IconCheck, IconSelector } from '@tabler/icons-react';
import { withController } from '~/libs/form/hoc/withController';
import { SupportButtonPolymorphic } from '~/components/SupportButton/SupportButton';
import { RequireMembership } from '~/components/RequireMembership/RequireMembership';

type Format = 'jpeg' | 'png';
const formatOptions: { label: string; value: Format; offset: number; memberOnly?: boolean }[] = [
  { label: 'JPEG', value: 'jpeg', offset: 0 },
  { label: 'PNG', value: 'png', offset: 2, memberOnly: true },
];

export function PreferredImageFormat({
  label = 'Output Format',
  value,
  onChange,
  placeholder = 'select...',
}: {
  label?: string;
  value?: Format;
  onChange?: (format: Format) => void;
  placeholder?: string;
}) {
  const handleChange = (value: Format) => {
    onChange?.(value);
  };
  const currentUser = useCurrentUser();
  const isMember = currentUser?.isPaidMember ?? false;
  const selected = value ? formatOptions.find((x) => x.value === value) : undefined;

  return (
    <Input.Wrapper label={label}>
      <Listbox value={value} onChange={handleChange}>
        <div className="relative">
          <ListboxButton
            className={clsx(
              'grid w-full cursor-default grid-cols-1 rounded-md py-1.5 pl-3 pr-2 text-left outline outline-1 -outline-offset-1 focus:outline focus:outline-2 focus:-outline-offset-2  sm:text-sm/6',
              'bg-white text-dark-9 outline-gray-4 focus:outline-blue-5',
              'dark:bg-dark-6 dark:text-dark-0 dark:outline-dark-4 dark:focus:outline-blue-8'
            )}
          >
            <span className="col-start-1 row-start-1 flex items-center gap-3 pr-6">
              {!selected ? (
                placeholder
              ) : (
                <FormatLabel {...selected} isFreeForMember={isMember && selected.value === 'png'} />
              )}
            </span>
            <IconSelector
              aria-hidden="true"
              className={clsx(
                'col-start-1 row-start-1 size-5 self-center justify-self-end sm:size-4',
                'text-gray-6'
              )}
            />
          </ListboxButton>

          <ListboxOptions
            transition
            anchor="bottom start"
            portal
            className={clsx(
              'z-[1000] mt-1 max-h-56 w-[var(--button-width)] overflow-auto rounded-md py-1 text-base shadow-lg ring-1 ring-black/5 focus:outline-none data-[closed]:data-[leave]:opacity-0 data-[leave]:transition data-[leave]:duration-100 data-[leave]:ease-in sm:text-sm',
              'bg-white',
              'dark:bg-dark-6'
            )}
          >
            {formatOptions.map((option) => {
              return (
                <ListboxOption
                  key={option.value}
                  value={option.value}
                  className={clsx(
                    'group relative cursor-default select-none justify-between py-2 pl-6 pr-9 data-[focus]:outline-none',
                    'text-dark-9 data-[focus]:bg-blue-5 data-[focus]:text-white',
                    'dark:text-dark-0 dark:data-[focus]:bg-blue-8 '
                  )}
                >
                  <div className="flex items-center">
                    <span className="block truncate group-data-[selected]:font-semibold">
                      <FormatLabel
                        {...option}
                        isFreeForMember={isMember && option.value === 'png'}
                      />
                    </span>
                  </div>

                  <span
                    className={clsx(
                      'absolute inset-y-0 right-0 flex items-center pr-4 group-[&:not([data-selected])]:hidden ',
                      'text-blue-5 group-data-[focus]:text-white',
                      'dark:text-blue-8'
                    )}
                  >
                    <IconCheck aria-hidden="true" className="size-5" />
                  </span>
                </ListboxOption>
              );
            })}
          </ListboxOptions>
        </div>
      </Listbox>
    </Input.Wrapper>
  );
}

function FormatLabel({
  label,
  offset,
  isFreeForMember = false,
}: {
  label: string;
  offset: number;
  isFreeForMember?: boolean;
}) {
  return (
    <div className="flex items-center gap-3">
      <span>{label}</span>
      {offset > 0 && (
        <span className={clsx('flex items-center', isFreeForMember && 'line-through opacity-50')}>
          <span>+</span>
          <span className="flex items-center">
            <IconBolt className="fill-yellow-7 stroke-yellow-7" size={16} />
            <span>{offset}</span>
          </span>
        </span>
      )}
      {isFreeForMember && (
        <span className="text-xs text-green-6 dark:text-green-5">Free for Members</span>
      )}
    </div>
  );
}

export const InputPreferredImageFormat = withController(PreferredImageFormat);
