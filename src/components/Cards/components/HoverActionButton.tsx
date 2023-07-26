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

const CUSTOM_VARIANTS = ['white'] as const;
type CustomVariantType = (typeof CUSTOM_VARIANTS)[number];

const useStyles = createStyles((theme, { size }: { size: number }, getRef) => {
  const labelRef = getRef('label');
  const hoverIconRef = getRef('hover');
  const customVariantsRef: Partial<Record<CustomVariantType, string>> = CUSTOM_VARIANTS.reduce(
    (acc, variant) => ({ ...acc, [variant]: getRef(variant) }),
    {}
  );

  const customVariantsClasses: Partial<Record<CustomVariantType, { ref: string }>> =
    CUSTOM_VARIANTS.reduce(
      (acc, variant) => ({ ...acc, [variant]: { ref: customVariantsRef[variant] } }),
      {}
    );

  return {
    ...customVariantsClasses,
    wrapper: {
      position: 'relative',
      height: size,
      width: size,
      zIndex: 0,

      '&:hover': {
        [`& .${labelRef}`]: {
          transform: 'scaleX(1)',
          opacity: 1,
        },
        [`& .${hoverIconRef}`]: {
          opacity: 1,
        },
      },
    },

    icon: {
      zIndex: 1,

      [`.${customVariantsRef.white} &`]: {
        backgroundColor: theme.colors.gray[3],
        color: theme.colors.dark[6],
      },
    },

    hover: {
      ref: hoverIconRef,
      opacity: 0,
      position: 'absolute',
      top: 0,
      left: 0,
      transition: 'opacity 200ms ease',

      [`.${customVariantsRef.white} &`]: {
        backgroundColor: theme.colors.gray[3],
        color: theme.colors.dark[6],
      },
    },

    label: {
      ref: labelRef,
      top: 0,
      right: 0,
      width: 'auto',
      paddingRight: size,
      minWidth: 3 * size,
      transform: 'scaleX(0)',
      height: '100%',
      overflow: 'hidden',
      position: 'absolute',
      transformOrigin: '90%',
      transition: 'transform 200ms ease, opacity 200ms ease',
      borderRadius: theme.radius.xl,
      display: 'flex',
      alignItems: 'center',
      flexWrap: 'nowrap',
      whiteSpace: 'nowrap',
      zIndex: 0,
      justifyContent: 'flex-start',
      paddingLeft: theme.spacing.md,
      opacity: 0,

      [`.${customVariantsRef.white} &`]: {
        backgroundColor: theme.colors.gray[3],
        color: theme.colors.dark[6],
      },
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
  const isCustomVariant = CUSTOM_VARIANTS.includes(color as CustomVariantType);
  const colorCustomVariant = color as CustomVariantType;

  return (
    <UnstyledButton
      onClick={onClick}
      className={isCustomVariant ? classes[colorCustomVariant] : undefined}
      {...props}
    >
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
  color?: MantineColor | CustomVariantType;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
};
export default HoverActionButton;
