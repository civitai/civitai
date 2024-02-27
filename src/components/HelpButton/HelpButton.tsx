import {
  ActionIcon,
  ActionIconProps,
  Button,
  ButtonProps,
  Text,
  Tooltip,
  createStyles,
} from '@mantine/core';
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

const useStyles = createStyles(() => ({
  floatingButton: {
    position: 'fixed',
    right: -179,
    top: 56,
    transition: 'right .3s ease',
    borderTopRightRadius: 0,
    borderBottomRightRadius: 0,

    '&:hover,&:focus': {
      right: 0,
    },
  },
}));

export function FloatingHelpButton({
  iconProps,
  className,
  label,
  ...buttonProps
}: Omit<ButtonProps, 'children'> & {
  iconProps?: TablerIconsProps;
  label?: string;
  onClick: React.MouseEventHandler<HTMLButtonElement>;
}) {
  const { classes, cx } = useStyles();

  return (
    <Button
      className={cx(classes.floatingButton, className)}
      size="md"
      color="blue.8"
      {...buttonProps}
      leftIcon={<IconHelpCircle {...iconProps} />}
    >
      {label ?? 'How does this work?'}
    </Button>
  );
}
