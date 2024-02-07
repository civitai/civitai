import { ActionIcon, ActionIconProps, Text, Tooltip } from '@mantine/core';
import { IconHelpCircle, TablerIconsProps } from '@tabler/icons-react';
import { forwardRef } from 'react';

export const HelpButton = forwardRef<HTMLButtonElement, Props>(
  ({ iconProps, tooltip, ...actionIconProps }, ref) => {
    const button = (
      <ActionIcon ref={ref} {...actionIconProps}>
        <Text color="dimmed" inline>
          <IconHelpCircle {...iconProps} />
        </Text>
      </ActionIcon>
    );

    if (tooltip) return <Tooltip label={tooltip}>{button}</Tooltip>;

    return button;
  }
);
HelpButton.displayName = 'HelpButton';

type Props = Omit<
  React.HTMLAttributes<HTMLButtonElement> &
    ActionIconProps & { iconProps?: TablerIconsProps; tooltip?: string },
  'children'
>;
