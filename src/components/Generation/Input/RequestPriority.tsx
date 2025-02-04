import { Priority } from '@civitai/client';
import { Input } from '@mantine/core';
import { IconBolt } from '@tabler/icons-react';
import { ChangeEventHandler, useState } from 'react';
import { GenerationPriorityLevelMap } from '~/server/orchestrator/infrastructure/base.enums';
import { Radio, RadioGroup } from '@headlessui/react';

import { trpc } from '~/utils/trpc';

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

  console.log({ selected });

  return (
    <Input.Wrapper label={label}>
      <fieldset aria-label="request-priority">
        <RadioGroup value={selected} onChange={handleChange} className="space-y-0.5">
          {Object.values(Priority)
            .reverse()
            .map((priority) => {
              const options = priorityOptionsMap[priority];
              const volume = data?.[GenerationPriorityLevelMap[priority]] ?? 0;
              const active = value === priority;
              return (
                <Radio
                  key={priority}
                  value={priority}
                  aria-label={priority}
                  className="focus:outline-hidden data-focus:border-blue-6 data-focus:ring-2 data-focus:ring-blue-6 group relative flex cursor-pointer justify-between rounded-lg border border-gray-300 bg-white px-6 py-4 shadow-sm dark:border-dark-6 dark:bg-dark-8"
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
                    className="group-data-checked:border-blue-6 group-data-focus:border pointer-events-none absolute -inset-px rounded-lg border-2 border-transparent"
                  />
                </Radio>
              );
            })}
        </RadioGroup>
      </fieldset>
    </Input.Wrapper>
  );
}
