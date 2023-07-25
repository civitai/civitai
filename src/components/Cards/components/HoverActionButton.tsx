import React from 'react';
import {
  Box,
  createStyles,
  MantineColor,
  Text,
  ThemeIcon,
  ThemeIconProps,
  UnstyledButton,
} from '@mantine/core';

const useStyles = createStyles(
  (theme, { size, color }: { size: number; color: MantineColor }, getRef) => {
    const labelRef = getRef('label');

    return {
      wrapper: {
        position: 'relative',
        height: size,
        width: size,

        '&:hover': {
          [`& .${labelRef}`]: {
            width: 3 * size,
            left: -2 * size,
          },
        },
      },

      label: {
        ref: labelRef,
        position: 'absolute',
        height: '100%',
        width: size,
        overflow: 'hidden',
        top: 0,
        left: 0,
        transformOrigin: '100% 50%',
        transition: 'all 200ms ease',
        background: theme.colors[color],
        borderRadius: theme.radius.xl,
        display: 'flex',
        alignItems: 'center',
        paddingLeft: theme.spacing.sm,
        flexWrap: 'nowrap',
        whiteSpace: 'nowrap',
      },
    };
  }
);
const HoverActionButton = ({
  label,
  children,
  themeIconProps = {},
  size,
  color = 'blue',
  ...props
}: Props) => {
  const { classes } = useStyles({ size, color });
  return (
    <UnstyledButton {...props}>
      <Box className={classes.wrapper}>
        <Box className={classes.label} color={color}>
          <Text size="xs">{label}</Text>
        </Box>
        <ThemeIcon {...themeIconProps} color={color} radius="xl" size={size}>
          {children}
        </ThemeIcon>
      </Box>
    </UnstyledButton>
  );
};

type Props = {
  label: string;
  children: React.ReactNode;
  themeIconProps?: Omit<ThemeIconProps, 'children' | 'size' | 'color'>;
  size: number;
  color?: MantineColor;
};
export default HoverActionButton;
