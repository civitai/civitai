import { Tooltip } from '@mantine/core';
import clsx from 'clsx';
import type { ReactNode } from 'react';

export type ButtonGroupOption = {
  label: ReactNode;
  value: string;
  description?: string;
};

type Props = {
  value: string;
  onChange: (value: string) => void;
  data: ButtonGroupOption[];
  className?: string;
};

export function ButtonGroupInput({ value, onChange, data, className }: Props) {
  return (
    <div className={clsx('flex gap-1', className)}>
      {data.map((item) => {
        const isActive = item.value === value;

        return (
          <Tooltip
            key={item.value}
            label={item.description}
            withinPortal
            position="bottom"
            disabled={!item.description}
          >
            <button
              type="button"
              onClick={() => onChange(item.value)}
              className={clsx(
                'flex flex-1 flex-col items-center justify-center gap-1 rounded-lg px-3 py-2 transition-colors',
                isActive
                  ? 'bg-[var(--mantine-color-blue-light)] text-[var(--mantine-color-blue-light-color)] ring-1 ring-inset ring-[var(--mantine-color-blue-filled)]'
                  : 'text-[var(--mantine-color-text)] ring-1 ring-inset ring-[var(--mantine-color-default-border)] hover:bg-[var(--mantine-color-default-hover)]'
              )}
            >
              <span className="text-xs font-semibold leading-tight">{item.label}</span>
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}
