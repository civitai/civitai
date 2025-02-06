import { Priority } from '@civitai/client';
import { ActionIcon, Input, Select, Tooltip } from '@mantine/core';
import { IconBolt, IconLock } from '@tabler/icons-react';
import { ChangeEventHandler, useState } from 'react';
import { GenerationPriorityLevelMap } from '~/server/orchestrator/infrastructure/base.enums';
import { Radio, RadioGroup } from '@headlessui/react';

import { trpc } from '~/utils/trpc';
import { capitalize } from 'lodash-es';
import clsx from 'clsx';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { Label, Listbox, ListboxButton, ListboxOption, ListboxOptions } from '@headlessui/react';
import { IconCheck, IconSelector } from '@tabler/icons-react';
import { withController } from '~/libs/form/hoc/withController';

const priorityOptionsMap: Record<
  Priority,
  { label: string; offset: number; memberOnly?: boolean }
> = {
  low: { label: 'Standard', offset: 0 },
  normal: { label: 'High', offset: 10 },
  high: { label: 'Highest', offset: 20, memberOnly: true },
};

export function RequestPriority3({
  label = 'Request Priority',
  value,
  onChange,
  placeholder = 'select...',
}: {
  label?: string;
  value?: Priority;
  onChange?: (priority: Priority) => void;
  placeholder?: string;
}) {
  const handleChange = (value: Priority) => {
    onChange?.(value);
  };
  const currentUser = useCurrentUser();
  const selected = value ? priorityOptionsMap[value] : undefined;

  return (
    <Input.Wrapper label={label}>
      <Listbox value={value} onChange={handleChange}>
        <div className="relative mt-2">
          <ListboxButton
            className={clsx(
              'grid w-full cursor-default grid-cols-1 rounded-md py-1.5 pl-3 pr-2 text-left outline outline-1 -outline-offset-1 focus:outline focus:outline-2 focus:-outline-offset-2  sm:text-sm/6',
              'bg-white text-dark-9 outline-gray-4 focus:outline-blue-5',
              'dark:bg-dark-6 dark:text-dark-0 dark:outline-dark-4 dark:focus:outline-blue-8'
            )}
          >
            <span className="col-start-1 row-start-1 flex items-center gap-3 pr-6">
              {/* <img alt="" src={selected.avatar} className="size-5 shrink-0 rounded-full" /> */}
              {!selected ? placeholder : <PriorityLabel {...selected} />}
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
              'z-10 mt-1 max-h-56 w-[var(--button-width)] overflow-auto rounded-md py-1 text-base shadow-lg ring-1 ring-black/5 focus:outline-none data-[closed]:data-[leave]:opacity-0 data-[leave]:transition data-[leave]:duration-100 data-[leave]:ease-in sm:text-sm',
              'bg-white',
              'dark:bg-dark-6'
            )}
          >
            {Object.values(Priority)
              .reverse()
              .map((priority) => {
                const options = priorityOptionsMap[priority];
                const disabled = options.memberOnly && !currentUser?.isPaidMember;
                return (
                  <ListboxOption
                    key={priority}
                    value={priority}
                    disabled={disabled}
                    className={clsx(
                      'group relative cursor-default select-none justify-between py-2 pl-3 pr-9 data-[disabled]:opacity-50 data-[focus]:outline-none',
                      'text-dark-9 data-[focus]:bg-blue-5 data-[focus]:text-white',
                      'dark:text-dark-0 dark:data-[focus]:bg-blue-8 '
                    )}
                  >
                    <div className="flex items-center">
                      {/* <img alt="" src={person.avatar} className="size-5 shrink-0 rounded-full" /> */}
                      <span className="ml-3 block truncate font-normal group-data-[selected]:font-semibold">
                        <PriorityLabel {...options} disabled={disabled} />
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
  disabled,
}: {
  label: string;
  offset: number;
  disabled?: boolean;
}) {
  return (
    <Tooltip withinPortal label="Member only" disabled={!disabled} withArrow offset={2}>
      <div className="flex items-center gap-3">
        <span>{label}</span>
        {offset > 0 && (
          <span className="flex items-center">
            <span>+</span>
            <span className="flex items-center">
              <IconBolt className="fill-yellow-7 stroke-yellow-7" size={16} />
              <span>{offset}</span>
            </span>
          </span>
        )}
        {disabled && <IconLock className="size-5" />}
      </div>
    </Tooltip>
  );
}

export function RequestPriority({
  label = 'Request Priority',
  value,
  onChange,
}: {
  label?: string;
  value?: Priority;
  onChange?: (priority: Priority) => void;
}) {
  // const { data, isLoading } = trpc.orchestrator.requestPriority.useQuery(undefined, {
  //   refetchInterval: 10 * 1000,
  // });

  // const [selected, setSelected] = useState<Priority>('low');
  const handleChange = (value: Priority) => {
    onChange?.(value);
    // setSelected(value);
  };
  const currentUser = useCurrentUser();

  return (
    <Input.Wrapper label={label}>
      <RadioGroup
        value={value}
        onChange={handleChange}
        className="mt-1 grid grid-cols-3 gap-3 @max-xs:grid-cols-1 @max-xs:gap-2"
      >
        {Object.values(Priority)
          .reverse()
          .map((priority) => {
            const options = priorityOptionsMap[priority];
            const disabled = options.memberOnly && !currentUser?.isPaidMember;
            return (
              <Tooltip key={priority} label="Member only" disabled={!disabled} withArrow offset={2}>
                <Radio
                  key={priority}
                  value={priority}
                  aria-label={priority}
                  disabled={disabled}
                  className={clsx(
                    disabled
                      ? 'cursor-not-allowed opacity-50'
                      : 'cursor-pointer focus:outline-none',
                    'flex flex-1 items-center justify-center rounded-md  p-3 text-sm font-semibold uppercase ring-1  data-[checked]:text-white   data-[checked]:ring-0 data-[focus]:data-[checked]:ring-2 data-[focus]:ring-2 data-[focus]:ring-offset-2  sm:flex-1  [&:not([data-focus])]:[&:not([data-checked])]:ring-inset  ',
                    'bg-white text-dark-9 ring-gray-4 hover:bg-gray-1 data-[checked]:bg-blue-5 data-[focus]:ring-blue-5 ',
                    'dark:bg-dark-5 dark:text-white dark:ring-dark-4 dark:hover:bg-dark-4 dark:data-[checked]:bg-blue-8 dark:data-[focus]:ring-blue-8 '
                  )}
                >
                  <div className="flex items-center gap-3">
                    {disabled && <IconLock size={16} />}
                    <span>{options.label}</span>
                    {options.offset > 0 && (
                      <span className="flex items-center">
                        <span>+</span>
                        <span className="flex items-center">
                          <IconBolt className="fill-yellow-7 stroke-yellow-7" size={16} />
                          <span>{options.offset}</span>
                        </span>
                      </span>
                    )}
                  </div>
                </Radio>
              </Tooltip>
            );
          })}
      </RadioGroup>
      {/* <fieldset
        aria-label="Request Priority"
        className="relative -space-y-px rounded-md bg-white dark:bg-dark-6"
      >
        {Object.values(Priority)
          .reverse()
          .map((priority) => {
            const options = priorityOptionsMap[priority];
            const volume = data?.[GenerationPriorityLevelMap[priority]] ?? 0;
            return (
              <label
                key={priority}
                aria-label={priority}
                className="group flex cursor-pointer border border-gray-3 p-4 first:rounded-t-md last:rounded-b-md focus:outline-none has-[:checked]:relative has-[:checked]:border-blue-2 has-[:checked]:bg-blue-1 @md:pl-4 @md:pr-6 dark:border-dark-4 dark:has-[:checked]:border-blue-5 dark:has-[:checked]:bg-blue-8"
              >
                <span className="flex items-center gap-3 text-sm text-dark-9 dark:text-white ">
                  <input
                    defaultValue={priority}
                    defaultChecked={priority === selected}
                    name="pricing-plan"
                    type="radio"
                    className="relative size-4 appearance-none rounded-full border border-gray-4 bg-white before:absolute before:inset-1 before:rounded-full before:bg-white checked:border-blue-6 checked:bg-blue-6 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-6 dark:border-dark-6 dark:checked:border-blue-5 dark:checked:bg-blue-5 forced-colors:appearance-auto forced-colors:before:hidden [&:not(:checked)]:before:hidden"
                  />
                  <span className="font-medium ">{options.label}</span>
                  {options.offset > 0 && (
                    <span className="flex items-center">
                      <span>+</span>
                      <span className="flex items-center">
                        <IconBolt className="fill-yellow-7 stroke-yellow-7" size={16} />
                        <span>{options.offset}</span>
                      </span>
                    </span>
                  )}
                </span>
                <span className="ml-auto pl-1 text-right text-sm text-gray-7 dark:text-gray-1">
                  Request Volume: {volume}
                </span>
              </label>
            );
          })}
      </fieldset> */}
    </Input.Wrapper>
  );
}

// export function RequestPriority2({
//   label = 'Request Priority',
//   value,
//   onChange,
// }: {
//   label?: string;
//   value?: Priority;
//   onChange?: (priority: Priority) => void;
// }) {
//   const { data, isLoading } = trpc.orchestrator.requestPriority.useQuery(undefined, {
//     refetchInterval: 10 * 1000,
//   });

//   const [selected, setSelected] = useState<Priority>('low');
//   const handleChange = (value: Priority) => {
//     onChange?.(value);
//     setSelected(value);
//   };

//   return (
//     <Input.Wrapper label={label}>
//       <fieldset aria-label="request-priority">
//         <RadioGroup value={selected} onChange={handleChange} className="space-y-0.5">
//           {Object.values(Priority)
//             .reverse()
//             .map((priority) => {
//               const options = priorityOptionsMap[priority];
//               const volume = data?.[GenerationPriorityLevelMap[priority]] ?? 0;
//               return (
//                 <Radio
//                   key={priority}
//                   value={priority}
//                   aria-label={priority}
//                   className="focus:outline-hidden group relative flex cursor-pointer justify-between rounded-lg border border-gray-3 bg-white px-6 py-4 shadow-sm data-[focus]:border-blue-6 data-[focus]:ring-2 data-[focus]:ring-blue-6 dark:border-dark-6 dark:bg-dark-8"
//                 >
//                   <div className="flex items-center gap-5">
//                     <span>{options.label}</span>
//                     {options.offset > 0 && (
//                       <span className="flex items-center gap-0.5">
//                         <span>+</span>
//                         <span className="flex items-center">
//                           <IconBolt className="fill-yellow-7 stroke-yellow-7" size={16} />
//                           <span>{options.offset}</span>
//                         </span>
//                       </span>
//                     )}
//                   </div>
//                   <div className="flex items-center justify-end gap-1">
//                     <div className="relative inline-flex items-center rounded-md bg-white px-3 py-2 text-sm font-semibold text-dark-9 shadow-sm ring-1 ring-inset ring-gray-3  dark:bg-dark-6 dark:text-white dark:ring-dark-4">
//                       Request Volume: {volume}
//                     </div>
//                   </div>
//                   <span
//                     aria-hidden="true"
//                     className="pointer-events-none absolute -inset-px rounded-lg border-2 border-transparent group-data-[focus]:border group-data-[checked]:border-blue-6"
//                   />
//                 </Radio>
//               );
//             })}
//         </RadioGroup>
//       </fieldset>
//     </Input.Wrapper>
//   );
// }

export const InputRequestPriority = withController(RequestPriority3);
