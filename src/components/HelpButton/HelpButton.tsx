import { ActionIcon, ActionIconProps, Text, Tooltip } from '@mantine/core';
import { IconHelpCircle, IconProps } from '@tabler/icons-react';
import { forwardRef } from 'react';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

export const HelpButton = forwardRef<HTMLButtonElement, Props>(
  ({ iconProps, tooltip, ...actionIconProps }, ref) => {
    const button = (
      <LegacyActionIcon ref={ref} {...actionIconProps}>
        <Text c="dimmed" inline>
          <IconHelpCircle {...iconProps} />
        </Text>
      </LegacyActionIcon>
    );

    if (tooltip) return <Tooltip label={tooltip}>{button}</Tooltip>;

    return button;
  }
);
HelpButton.displayName = 'HelpButton';

type Props = Omit<
  React.HTMLAttributes<HTMLButtonElement> &
    ActionIconProps & { iconProps?: IconProps; tooltip?: string },
  'children'
>;
