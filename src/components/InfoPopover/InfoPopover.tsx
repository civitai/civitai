import type { ActionIconProps, PopoverProps } from '@mantine/core';
import { ActionIcon, HoverCard, Popover as MantinePopover, Text } from '@mantine/core';
import type { Icon, IconProps } from '@tabler/icons-react';
import { IconInfoCircle } from '@tabler/icons-react';
import clsx from 'clsx';
import React, { forwardRef } from 'react';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

export const InfoPopover = forwardRef<HTMLButtonElement, Props>(
  (
    {
      iconProps,
      buttonProps,
      size,
      variant,
      children,
      type = 'click',
      hideClick,
      customIcon,
      ...popoverProps
    },
    ref
  ) => {
    const Popover = type === 'hover' ? HoverCard : MantinePopover;
    const Icon = !!customIcon ? customIcon : IconInfoCircle;

    return (
      <Popover width={300} {...popoverProps} shadow="sm">
        <Popover.Target>
          <LegacyActionIcon
            ref={ref}
            {...buttonProps}
            size={size}
            variant={variant}
            className={clsx({
              ['active:transform-none']: !!hideClick,
              ['cursor-help']: !!hideClick,
            })}
          >
            <Text c="dimmed" inline>
              <Icon {...iconProps} />
            </Text>
          </LegacyActionIcon>
        </Popover.Target>
        <Popover.Dropdown>{children}</Popover.Dropdown>
      </Popover>
    );
  }
);
InfoPopover.displayName = 'InfoPopover';

type Props = PopoverProps & {
  children: React.ReactNode;
  size?: ActionIconProps['size'];
  variant?: ActionIconProps['variant'];
  buttonProps?: Omit<
    React.HTMLAttributes<HTMLButtonElement> & ActionIconProps,
    'children' | 'onClick'
  >;
  iconProps?: IconProps;
  type?: 'hover' | 'click';
  hideClick?: boolean; // TODO consider this behavior if type === hover
  customIcon?: Icon;
  className?: string;
};
