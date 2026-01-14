/**
 * Output Format Input Component
 *
 * A compact dropdown selector for output image format (JPEG/PNG).
 * Works with the DataGraph Controller pattern, receiving options from meta.
 */

import { Menu, Tooltip, UnstyledButton } from '@mantine/core';
import { IconBolt, IconPhoto } from '@tabler/icons-react';
import clsx from 'clsx';

// =============================================================================
// Types
// =============================================================================

export type OutputFormat = 'jpeg' | 'png';

export interface OutputFormatOption {
  label: string;
  value: string;
  offset?: number;
}

export interface OutputFormatInputProps {
  value?: string;
  onChange?: (format: string) => void;
  options: OutputFormatOption[];
  isMember?: boolean;
}

// =============================================================================
// Format Label Component
// =============================================================================

interface FormatLabelProps {
  label: string;
  offset?: number;
  isFreeForMember?: boolean;
}

function FormatLabel({ label, offset = 0, isFreeForMember = false }: FormatLabelProps) {
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

// =============================================================================
// Component
// =============================================================================

export function OutputFormatInput({
  value,
  onChange,
  options,
  isMember = false,
}: OutputFormatInputProps) {
  const selected = value ? options.find((x) => x.value === value) : undefined;

  return (
    <Menu position="bottom-start" withinPortal>
      <Tooltip label="Output Format" position="top" withArrow>
        <Menu.Target>
          <UnstyledButton
            className={clsx(
              'flex items-center gap-1.5 rounded-md px-2 py-1 text-sm',
              'bg-gray-1 hover:bg-gray-2',
              'dark:bg-dark-5 dark:hover:bg-dark-4'
            )}
          >
            <IconPhoto size={16} className="text-gray-6 dark:text-dark-2" />
            <span className="font-medium">{selected?.label ?? 'JPEG'}</span>
            {selected && (selected.offset ?? 0) > 0 && (
              <span className={clsx('flex items-center', isMember && 'line-through opacity-50')}>
                <span className="text-xs">+</span>
                <IconBolt className="fill-yellow-7 stroke-yellow-7" size={14} />
                <span className="text-xs">{selected.offset}</span>
              </span>
            )}
          </UnstyledButton>
        </Menu.Target>
      </Tooltip>
      <Menu.Dropdown>
        {options.map((option) => (
          <Menu.Item
            key={option.value}
            onClick={() => onChange?.(option.value)}
            className={clsx(value === option.value && 'bg-blue-5/10 dark:bg-blue-8/20')}
          >
            <FormatLabel
              label={option.label}
              offset={option.offset}
              isFreeForMember={isMember && option.value === 'png'}
            />
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}
