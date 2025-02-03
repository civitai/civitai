import { Priority } from '@civitai/client';
import { Input } from '@mantine/core';
import { ChangeEventHandler } from 'react';
import { GenerationPriorityLevelMap } from '~/server/orchestrator/infrastructure/base.enums';

import { trpc } from '~/utils/trpc';

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
    staleTime: 10 * 1000,
  });

  const items = data
    ? Object.values(Priority)
        .reverse()
        .map((priority) => ({
          label: priority,
          value: priority,
          volume: data[GenerationPriorityLevelMap[priority]] ?? 0,
        }))
    : [];

  const handleChange: ChangeEventHandler<HTMLInputElement> = (e) => {
    onChange?.(e.target.value as Priority);
  };

  return (
    <Input.Wrapper label={label}>
      {items.map((item) => {
        const active = value === item.value;
        return (
          <div key={item.value}>
            <input
              type="radio"
              name={item.value}
              value={item.value}
              onChange={handleChange}
              className="hidden"
            />
            <label htmlFor={item.value}>
              {item.label} - {item.volume}
            </label>
          </div>
        );
      })}
    </Input.Wrapper>
  );
}
