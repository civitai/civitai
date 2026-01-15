import { Priority } from '@civitai/client';
import { Box, Input, Menu, Tooltip, UnstyledButton } from '@mantine/core';
import { useEffect } from 'react';
import { IconBolt, IconDiamond, IconRocket } from '@tabler/icons-react';
import clsx from 'clsx';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from '@headlessui/react';
import { IconCheck, IconSelector } from '@tabler/icons-react';
import { withController } from '~/libs/form/hoc/withController';
import { RequireMembership } from '~/components/RequireMembership/RequireMembership';
import { SupportButtonPolymorphic } from '~/components/SupportButton/SupportButton';

const priorityOptionsMap: Record<
  Priority,
  { label: string; offset: number; memberOnly?: boolean }
> = {
  low: { label: 'Standard', offset: 0 },
  normal: { label: 'High', offset: 10 },
  high: { label: 'Highest', offset: 20, memberOnly: true },
};

export function RequestPriority({
  label = 'Request Priority',
  value,
  onChange,
  placeholder = 'select...',
  modifier = 'fixed',
}: {
  label?: string;
  value?: Priority;
  onChange?: (priority: Priority) => void;
  placeholder?: string;
  modifier?: 'fixed' | 'multiplier';
}) {
  const handleChange = (value: Priority) => {
    onChange?.(value);
  };
  const currentUser = useCurrentUser();
  const isMember = currentUser?.isPaidMember ?? false;
  const selected = value ? priorityOptionsMap[value] : undefined;

  // Auto-select High priority for members if Standard is selected or no value
  useEffect(() => {
    if (isMember && (!value || value === 'low')) {
      onChange?.('normal' as Priority);
    }
  }, [value, isMember]);

  // Temp disable priority
  // useEffect(() => {
  //   if (value !== 'low') onChange?.('low' as Priority);
  // }, [value]);

  // return null;

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
              {/* <img alt="" src={selected.avatar} className="size-5 shrink-0 rounded-full" /> */}
              {!selected ? (
                placeholder
              ) : (
                <PriorityLabel
                  {...selected}
                  modifier={modifier}
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
            {Object.values(Priority)
              .reverse()
              .filter((priority) => {
                // Hide Standard option for members
                if (isMember && priority === 'low') return false;
                return true;
              })
              .map((priority) => {
                const options = priorityOptionsMap[priority];
                const disabled = options.memberOnly && !currentUser?.isPaidMember;

                if (disabled)
                  return (
                    <div key={priority} className="px-1 pt-1">
                      <RequireMembership>
                        <SupportButtonPolymorphic
                          icon={IconDiamond}
                          position="right"
                          className="w-full !py-2 !pl-5 !pr-3"
                        >
                          <PriorityLabel {...options} modifier={modifier} />
                        </SupportButtonPolymorphic>
                      </RequireMembership>
                    </div>
                  );

                return (
                  <ListboxOption
                    key={priority}
                    value={priority}
                    disabled={disabled}
                    className={clsx(
                      'group relative cursor-default select-none justify-between py-2 pl-6 pr-9 data-[disabled]:opacity-50 data-[focus]:outline-none',
                      'text-dark-9 data-[focus]:bg-blue-5 data-[focus]:text-white',
                      'dark:text-dark-0 dark:data-[focus]:bg-blue-8 '
                    )}
                  >
                    <div className="flex items-center">
                      {/* <img alt="" src={person.avatar} className="size-5 shrink-0 rounded-full" /> */}
                      <span className="block truncate group-data-[selected]:font-semibold">
                        <PriorityLabel
                          {...options}
                          modifier={modifier}
                          isFreeForMember={isMember && priority === 'normal'}
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

function PriorityLabel({
  label,
  offset,
  modifier,
  isFreeForMember = false,
}: {
  label: string;
  offset: number;
  modifier: 'fixed' | 'multiplier';
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
            <span>
              {offset}
              {modifier === 'multiplier' ? '%' : ''}
            </span>
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

// export function RequestPriority({
//   label = 'Request Priority',
//   value,
//   onChange,
// }: {
//   label?: string;
//   value?: Priority;
//   onChange?: (priority: Priority) => void;
// }) {
//   const handleChange = (value: Priority) => {
//     onChange?.(value);
//   };
//   const currentUser = useCurrentUser();

//   return (
//     <Input.Wrapper label={label}>
//       <RadioGroup
//         value={value}
//         onChange={handleChange}
//         className="mt-1 grid grid-cols-3 gap-3 @max-xs:grid-cols-1 @max-xs:gap-2"
//       >
//         {Object.values(Priority)
//           .reverse()
//           .map((priority) => {
//             const options = priorityOptionsMap[priority];
//             const disabled = options.memberOnly && !currentUser?.isPaidMember;
//             return (
//               <Tooltip key={priority} label="Member only" disabled={!disabled} withArrow offset={2}>
//                 <Radio
//                   key={priority}
//                   value={priority}
//                   aria-label={priority}
//                   disabled={disabled}
//                   className={clsx(
//                     disabled
//                       ? 'cursor-not-allowed opacity-50'
//                       : 'cursor-pointer focus:outline-none',
//                     'flex flex-1 items-center justify-center rounded-md  p-3 text-sm font-semibold uppercase ring-1  data-[checked]:text-white   data-[checked]:ring-0 data-[focus]:data-[checked]:ring-2 data-[focus]:ring-2 data-[focus]:ring-offset-2  sm:flex-1  [&:not([data-focus])]:[&:not([data-checked])]:ring-inset  ',
//                     'bg-white text-dark-9 ring-gray-4 hover:bg-gray-1 data-[checked]:bg-blue-5 data-[focus]:ring-blue-5 ',
//                     'dark:bg-dark-5 dark:text-white dark:ring-dark-4 dark:hover:bg-dark-4 dark:data-[checked]:bg-blue-8 dark:data-[focus]:ring-blue-8 '
//                   )}
//                 >
//                   <div className="flex items-center gap-3">
//                     {disabled && <IconLock size={16} />}
//                     <span>{options.label}</span>
//                     {options.offset > 0 && (
//                       <span className="flex items-center">
//                         <span>+</span>
//                         <span className="flex items-center">
//                           <IconBolt className="fill-yellow-7 stroke-yellow-7" size={16} />
//                           <span>{options.offset}</span>
//                         </span>
//                       </span>
//                     )}
//                   </div>
//                 </Radio>
//               </Tooltip>
//             );
//           })}
//       </RadioGroup>
//     </Input.Wrapper>
//   );
// }

export const InputRequestPriority = withController(RequestPriority);

export function RequestPriorityCompact({
  value,
  onChange,
  modifier = 'fixed',
}: {
  value?: Priority;
  onChange?: (priority: Priority) => void;
  modifier?: 'fixed' | 'multiplier';
}) {
  const currentUser = useCurrentUser();
  const isMember = currentUser?.isPaidMember ?? false;
  const selected = value ? priorityOptionsMap[value] : undefined;

  // Auto-select High priority for members if Standard is selected or no value
  useEffect(() => {
    if (isMember && (!value || value === 'low')) {
      onChange?.('normal' as Priority);
    } else if (!isMember && value === 'high') {
      onChange?.('low');
    }
  }, [value, isMember]);

  return (
    <Menu position="bottom-start" withinPortal>
      <Tooltip label="Request Priority" position="top" withArrow>
        <Menu.Target>
          <UnstyledButton
            className={clsx(
              'flex items-center gap-1.5 rounded-md px-2 py-1 text-sm',
              'bg-gray-1 hover:bg-gray-2',
              'dark:bg-dark-5 dark:hover:bg-dark-4'
            )}
          >
            <IconRocket size={16} className="text-gray-6 dark:text-dark-2" />
            <span className="font-medium">{selected?.label ?? 'Standard'}</span>
            {selected && selected.offset > 0 && (
              <span
                className={clsx(
                  'flex items-center',
                  isMember && value === 'normal' && 'line-through opacity-50'
                )}
              >
                <span className="text-xs">+</span>
                <IconBolt className="fill-yellow-7 stroke-yellow-7" size={14} />
                <span className="text-xs">
                  {selected.offset}
                  {modifier === 'multiplier' ? '%' : ''}
                </span>
              </span>
            )}
          </UnstyledButton>
        </Menu.Target>
      </Tooltip>
      <Menu.Dropdown>
        {Object.values(Priority)
          .reverse()
          .filter((priority) => {
            // Hide Standard option for members
            if (isMember && priority === 'low') return false;
            return true;
          })
          .map((priority) => {
            const options = priorityOptionsMap[priority];
            const disabled = options.memberOnly && !currentUser?.isPaidMember;

            if (disabled)
              return (
                <div key={priority} className="px-1 pt-1">
                  <RequireMembership>
                    <SupportButtonPolymorphic
                      icon={IconDiamond}
                      position="right"
                      className="w-full !px-3 !py-2"
                    >
                      <PriorityLabel {...options} modifier={modifier} />
                    </SupportButtonPolymorphic>
                  </RequireMembership>
                </div>
              );

            return (
              <Menu.Item
                key={priority}
                onClick={() => onChange?.(priority)}
                className={clsx(value === priority && 'bg-blue-5/10 dark:bg-blue-8/20')}
              >
                <PriorityLabel
                  {...options}
                  modifier={modifier}
                  isFreeForMember={isMember && priority === 'normal'}
                />
              </Menu.Item>
            );
          })}
      </Menu.Dropdown>
    </Menu>
  );
}

export const InputRequestPriorityCompact = withController(RequestPriorityCompact);
