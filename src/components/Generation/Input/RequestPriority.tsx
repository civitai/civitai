import { Priority } from '@civitai/client';
import { Input } from '@mantine/core';
import { IconBolt } from '@tabler/icons-react';
import { ChangeEventHandler, useState } from 'react';
import { GenerationPriorityLevelMap } from '~/server/orchestrator/infrastructure/base.enums';
import { Radio, RadioGroup } from '@headlessui/react';

import { trpc } from '~/utils/trpc';
import { capitalize } from 'lodash-es';

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
}: {
  label?: string;
  value?: Priority;
  onChange?: (priority: Priority) => void;
}) {
  const { data, isLoading } = trpc.orchestrator.requestPriority.useQuery(undefined, {
    refetchInterval: 10 * 1000,
  });

  const [selected, setSelected] = useState<Priority>('low');
  const handleChange = (value: Priority) => {
    onChange?.(value);
    setSelected(value);
  };

  return (
    <Input.Wrapper label={label}>
      <fieldset
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
      </fieldset>
    </Input.Wrapper>
  );
}

export function RequestPriority2({
  label = 'Request Priority',
  value,
  onChange,
}: {
  label?: string;
  value?: Priority;
  onChange?: (priority: Priority) => void;
}) {
  const { data, isLoading } = trpc.orchestrator.requestPriority.useQuery(undefined, {
    refetchInterval: 10 * 1000,
  });

  const [selected, setSelected] = useState<Priority>('low');
  const handleChange = (value: Priority) => {
    onChange?.(value);
    setSelected(value);
  };

  return (
    <Input.Wrapper label={label}>
      <fieldset aria-label="request-priority">
        <RadioGroup value={selected} onChange={handleChange} className="space-y-0.5">
          {Object.values(Priority)
            .reverse()
            .map((priority) => {
              const options = priorityOptionsMap[priority];
              const volume = data?.[GenerationPriorityLevelMap[priority]] ?? 0;
              return (
                <Radio
                  key={priority}
                  value={priority}
                  aria-label={priority}
                  className="focus:outline-hidden group relative flex cursor-pointer justify-between rounded-lg border border-gray-3 bg-white px-6 py-4 shadow-sm data-[focus]:border-blue-6 data-[focus]:ring-2 data-[focus]:ring-blue-6 dark:border-dark-6 dark:bg-dark-8"
                >
                  <div className="flex items-center gap-5">
                    <span>{options.label}</span>
                    {options.offset > 0 && (
                      <span className="flex items-center gap-0.5">
                        <span>+</span>
                        <span className="flex items-center">
                          <IconBolt className="fill-yellow-7 stroke-yellow-7" size={16} />
                          <span>{options.offset}</span>
                        </span>
                      </span>
                    )}
                  </div>
                  <div className="flex items-center justify-end gap-1">
                    <div className="relative inline-flex items-center rounded-md bg-white px-3 py-2 text-sm font-semibold text-dark-9 shadow-sm ring-1 ring-inset ring-gray-3  dark:bg-dark-6 dark:text-white dark:ring-dark-4">
                      Request Volume: {volume}
                    </div>
                  </div>
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute -inset-px rounded-lg border-2 border-transparent group-data-[focus]:border group-data-[checked]:border-blue-6"
                  />
                </Radio>
              );
            })}
        </RadioGroup>
      </fieldset>
    </Input.Wrapper>
  );
}
