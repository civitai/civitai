import {
  ActionIcon,
  ActionIconProps,
  HoverCard,
  Popover as MantinePopover,
  PopoverProps,
  Text,
} from '@mantine/core';
import { Icon, IconInfoCircle, IconProps } from '@tabler/icons-react';
import clsx from 'clsx';
import React, { forwardRef } from 'react';

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
          <ActionIcon
            ref={ref}
            {...buttonProps}
            size={size}
            variant={variant}
            className={clsx({
              ['active:transform-none']: !!hideClick,
              ['cursor-help']: !!hideClick,
            })}
          >
            <Text color="dimmed" inline>
              <Icon {...iconProps} />
            </Text>
          </ActionIcon>
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
};
