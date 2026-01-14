/**
 * Priority Input Component
 *
 * A dropdown selector for request priority levels.
 * Works with the DataGraph Controller pattern, receiving options from meta.
 */

import { Input } from '@mantine/core';
import { IconBolt, IconCheck, IconSelector } from '@tabler/icons-react';
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from '@headlessui/react';
import clsx from 'clsx';

// =============================================================================
// Types
// =============================================================================

export type Priority = 'low' | 'normal' | 'high';

export interface PriorityOption {
  label: string;
  value: Priority;
  offset: number;
  memberOnly?: boolean;
  disabled?: boolean;
}

export interface PriorityInputProps {
  value?: Priority;
  onChange?: (priority: Priority) => void;
  label?: string;
  placeholder?: string;
  options: PriorityOption[];
  isMember?: boolean;
}

// =============================================================================
// Priority Label Component
// =============================================================================

interface PriorityLabelProps {
  label: string;
  offset: number;
  isFreeForMember?: boolean;
}

function PriorityLabel({ label, offset, isFreeForMember = false }: PriorityLabelProps) {
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
        <span className="text-xs text-green-6 dark:text-green-5">
          Members get High Priority Free
        </span>
      )}
    </div>
  );
}

// =============================================================================
// Component
// =============================================================================

export function PriorityInput({
  value,
  onChange,
  label = 'Request Priority',
  placeholder = 'select...',
  options,
  isMember = false,
}: PriorityInputProps) {
  const selected = value ? options.find((x) => x.value === value) : undefined;
  // Filter out disabled options from the dropdown
  const visibleOptions = options.filter((opt) => !opt.disabled);

  return (
    <Input.Wrapper label={label}>
      <Listbox value={value} onChange={(val) => onChange?.(val)}>
        <div className="relative">
          <ListboxButton
            className={clsx(
              'grid w-full cursor-default grid-cols-1 rounded-md py-1.5 pl-3 pr-2 text-left outline outline-1 -outline-offset-1 focus:outline focus:outline-2 focus:-outline-offset-2 sm:text-sm/6',
              'bg-white text-dark-9 outline-gray-4 focus:outline-blue-5',
              'dark:bg-dark-6 dark:text-dark-0 dark:outline-dark-4 dark:focus:outline-blue-8'
            )}
          >
            <span className="col-start-1 row-start-1 flex items-center gap-3 pr-6">
              {!selected ? (
                placeholder
              ) : (
                <PriorityLabel
                  label={selected.label}
                  offset={selected.offset}
                  isFreeForMember={isMember && value === 'normal'}
                />
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
            {visibleOptions.map((option) => (
              <ListboxOption
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className={clsx(
                  'group relative cursor-default select-none justify-between py-2 pl-6 pr-9 data-[disabled]:opacity-50 data-[focus]:outline-none',
                  'text-dark-9 data-[focus]:bg-blue-5 data-[focus]:text-white',
                  'dark:text-dark-0 dark:data-[focus]:bg-blue-8'
                )}
              >
                <div className="flex items-center">
                  <span className="block truncate group-data-[selected]:font-semibold">
                    <PriorityLabel
                      label={option.label}
                      offset={option.offset}
                      isFreeForMember={isMember && option.value === 'normal'}
                    />
                  </span>
                </div>

                <span
                  className={clsx(
                    'absolute inset-y-0 right-0 flex items-center pr-4 group-[&:not([data-selected])]:hidden',
                    'text-blue-5 group-data-[focus]:text-white',
                    'dark:text-blue-8'
                  )}
                >
                  <IconCheck aria-hidden="true" className="size-5" />
                </span>
              </ListboxOption>
            ))}
          </ListboxOptions>
        </div>
      </Listbox>
    </Input.Wrapper>
  );
}
