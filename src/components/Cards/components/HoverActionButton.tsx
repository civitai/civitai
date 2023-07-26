import React from 'react';
import {
  Badge,
  Box,
  createStyles,
  MantineColor,
  ThemeIcon,
  ThemeIconProps,
  UnstyledButton,
  UnstyledButtonProps,
} from '@mantine/core';
import { IconArrowRight } from '@tabler/icons-react';

const useStyles = createStyles((theme, { size }: { size: number }, getRef) => {
  const labelRef = getRef('label');
  const hoverIconRef = getRef('hover');

  return {
    wrapper: {
      position: 'relative',
      height: size,
      width: size,
      zIndex: 0,

      '&:hover': {
        [`& .${labelRef}`]: {
          width: 3 * size,
          left: -2 * size,
          opacity: 1,
        },
        [`& .${hoverIconRef}`]: {
          opacity: 1,
        },
      },
    },

    icon: {
      zIndex: 1,
    },

    hover: {
      ref: hoverIconRef,
      opacity: 0,
      position: 'absolute',
      top: 0,
      left: 0,
      transition: 'opacity 200ms ease',
    },

    label: {
      ref: labelRef,
      top: 0,
      left: 0,
      width: size,
      height: '100%',
      overflow: 'hidden',
      position: 'absolute',
      transformOrigin: '100% 50%',
      transition: 'width 200ms ease, left 200ms ease, opacity 200ms ease',
      borderRadius: theme.radius.xl,
      display: 'flex',
      alignItems: 'center',
      flexWrap: 'nowrap',
      whiteSpace: 'nowrap',
      zIndex: 0,
      justifyContent: 'flex-start',
      paddingLeft: theme.spacing.md,
      opacity: 0,
    },
  };
});
const HoverActionButton = ({
  label,
  children,
  size,
  themeIconProps = {},
  color = 'green',
  variant = 'filled',
  onClick,
  ...props
}: Props) => {
  const { classes } = useStyles({ size });
  return (
    <UnstyledButton onClick={onClick} {...props}>
      <Box className={classes.wrapper}>
        <Badge className={classes.label} size="xs" variant={variant} color={color}>
          {label}
        </Badge>
        <ThemeIcon
          {...themeIconProps}
          className={classes.icon}
          color={color}
          radius="xl"
          size={size}
          variant={variant}
        >
          {children}
        </ThemeIcon>
        <ThemeIcon
          {...themeIconProps}
          className={classes.hover}
          color={color}
          radius="xl"
          size={size}
          variant={variant}
        >
          <IconArrowRight size={16} stroke={2.5} />
        </ThemeIcon>
      </Box>
    </UnstyledButton>
  );
};

type Props = UnstyledButtonProps & {
  label: string;
  children: React.ReactNode;
  variant?: 'light' | 'filled';
  themeIconProps?: Omit<ThemeIconProps, 'children' | 'size' | 'color' | 'variant'>;
  size: number;
  color?: MantineColor;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
};
export default HoverActionButton;
