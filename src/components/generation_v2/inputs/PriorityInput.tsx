/**
 * Priority Input Component
 *
 * A compact dropdown selector for request priority levels.
 * Receives its options from the field meta.
 */

import { Menu, Tooltip, UnstyledButton } from '@mantine/core';
import { IconBolt, IconDiamond, IconRocket } from '@tabler/icons-react';
import clsx from 'clsx';
import { RequireMembership } from '~/components/RequireMembership/RequireMembership';
import { SupportButtonPolymorphic } from '~/components/SupportButton/SupportButton';
import { cloneElement, useState } from 'react';
import { PopoverOrSheet } from '~/components/generation_v2/PopoverOrSheet';
import { SheetOption } from '~/components/Drawer/SheetOption';
import { useMobileGenerator } from '~/hooks/useMobileGenerator';

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
  lineThrough?: boolean;
}

export interface PriorityInputProps {
  value?: Priority;
  onChange?: (priority: Priority) => void;
  options: PriorityOption[];
  isMember?: boolean;
  modifier?: 'fixed' | 'multiplier';
}

// =============================================================================
// Priority Label Component
// =============================================================================

interface PriorityLabelProps {
  label: string;
  offset: number;
  modifier?: 'fixed' | 'multiplier';
  isFreeForMember?: boolean;
}

function PriorityLabel({
  label,
  offset,
  modifier = 'fixed',
  isFreeForMember = false,
}: PriorityLabelProps) {
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
        <span className="text-xs text-green-6 dark:text-green-5">Free for Members</span>
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
  options,
  isMember = false,
  modifier = 'fixed',
}: PriorityInputProps) {
  const selected = value ? options.find((x) => x.value === value) : undefined;
  // Filter out disabled options from the dropdown
  const visibleOptions = options.filter((opt) => !opt.disabled);
  const mobileGenerator = useMobileGenerator();
  const [opened, setOpened] = useState(false);

  const trigger = (
    <UnstyledButton
      aria-label={`Request Priority: ${selected?.label ?? 'Standard'}`}
      data-tap-target
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
          className={clsx('flex items-center', selected?.lineThrough && 'line-through opacity-50')}
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
  );

  const membersOnly = (option: (typeof visibleOptions)[number]) => (
    <div key={option.value} className="px-1 pt-1">
      <RequireMembership>
        <SupportButtonPolymorphic
          icon={IconDiamond}
          position="right"
          className="w-full !px-3 !py-2"
        >
          <PriorityLabel label={option.label} offset={option.offset} modifier={modifier} />
        </SupportButtonPolymorphic>
      </RequireMembership>
    </div>
  );
  const label = (option: (typeof visibleOptions)[number]) => (
    <PriorityLabel
      label={option.label}
      offset={option.offset}
      modifier={modifier}
      isFreeForMember={option.lineThrough}
    />
  );

  if (mobileGenerator)
    return (
      <PopoverOrSheet
        opened={opened}
        onClose={() => setOpened(false)}
        title="Request Priority"
        target={cloneElement(trigger, { onClick: () => setOpened(true) })}
      >
        <div role="menu" aria-label="Request Priority">
          {visibleOptions.map((option) =>
            option.memberOnly && !isMember ? (
              membersOnly(option)
            ) : (
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
            )
          )}
        </div>
      </PopoverOrSheet>
    );

  return (
    <Menu position="bottom-start" withinPortal>
      <Tooltip label="Request Priority" position="top" withArrow>
        <Menu.Target>{trigger}</Menu.Target>
      </Tooltip>
      <Menu.Dropdown>
        {visibleOptions.map((option) => {
          if (option.memberOnly && !isMember) return membersOnly(option);

          return (
            <Menu.Item
              key={option.value}
              onClick={() => onChange?.(option.value)}
              className={clsx(value === option.value && 'bg-blue-5/10 dark:bg-blue-8/20')}
            >
              {label(option)}
            </Menu.Item>
          );
        })}
      </Menu.Dropdown>
    </Menu>
  );
}
