import { ActionIcon, ActionIconProps, Popover, PopoverProps, Text } from '@mantine/core';
import { IconInfoCircle, TablerIconsProps } from '@tabler/icons-react';
import React, { forwardRef } from 'react';

export const InfoPopover = forwardRef<HTMLButtonElement, Props>(
  ({ iconProps, buttonProps, size, variant, children, ...popoverProps }, ref) => {
    return (
      <Popover width={300} {...popoverProps}>
        <Popover.Target>
          <ActionIcon ref={ref} {...buttonProps} size={size} variant={variant}>
            <Text color="dimmed" inline>
              <IconInfoCircle {...iconProps} />
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
  iconProps?: TablerIconsProps;
};
