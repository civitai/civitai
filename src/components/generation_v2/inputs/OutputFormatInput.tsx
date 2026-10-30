/**
 * Output Format Input Component
 *
 * A compact dropdown selector for output image format (JPEG/PNG).
 * Receives its options from the field meta.
 */

import { Menu, Tooltip, UnstyledButton } from '@mantine/core';
import { IconBolt, IconPhoto } from '@tabler/icons-react';
import clsx from 'clsx';
import { cloneElement, useState } from 'react';
import { PopoverOrSheet } from '~/components/generation_v2/PopoverOrSheet';
import { SheetOption } from '~/components/Drawer/SheetOption';
import { useMobileGenerator } from '~/hooks/useMobileGenerator';

// =============================================================================
// Types
// =============================================================================

export type OutputFormat = 'jpeg' | 'png';

export interface OutputFormatOption<V extends string = string> {
  label: string;
  value: V;
  offset?: number;
}

export interface OutputFormatInputProps<V extends string = string> {
  value?: V;
  onChange?: (format: V) => void;
  options: OutputFormatOption<V>[];
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

export function OutputFormatInput<V extends string = string>({
  value,
  onChange,
  options,
  isMember = false,
}: OutputFormatInputProps<V>) {
  const selected = value ? options.find((x) => x.value === value) : undefined;
  const mobileGenerator = useMobileGenerator();
  const [opened, setOpened] = useState(false);

  const trigger = (
    <UnstyledButton
      // Keeps the selected value in the accessible name (WCAG 2.5.3, label in name); a bare
      // "Output Format" would drop it.
      aria-label={`Output Format: ${selected?.label ?? 'JPEG'}`}
      data-tap-target
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
  );

  const label = (option: OutputFormatOption<V>) => (
    <FormatLabel
      label={option.label}
      offset={option.offset}
      isFreeForMember={isMember && option.value === 'png'}
    />
  );

  if (mobileGenerator)
    return (
      <PopoverOrSheet
        opened={opened}
        onClose={() => setOpened(false)}
        title="Output Format"
        target={cloneElement(trigger, { onClick: () => setOpened(true) })}
      >
        <div role="menu" aria-label="Output Format">
          {options.map((option) => (
            <SheetOption
              key={option.value}
              role="menuitemradio"
              selected={value === option.value}
              onClick={() => {
                onChange?.(option.value);
                setOpened(false);
              }}
            >
              {label(option)}
            </SheetOption>
          ))}
        </div>
      </PopoverOrSheet>
    );

  return (
    <Menu position="bottom-start" withinPortal>
      <Tooltip label="Output Format" position="top" withArrow>
        <Menu.Target>{trigger}</Menu.Target>
      </Tooltip>
      <Menu.Dropdown>
        {options.map((option) => (
          <Menu.Item
            key={option.value}
            onClick={() => onChange?.(option.value)}
            className={clsx(value === option.value && 'bg-blue-5/10 dark:bg-blue-8/20')}
          >
            {label(option)}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}
