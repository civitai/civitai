import React from 'react';
import type { MantineColor, ThemeIconProps, UnstyledButtonProps } from '@mantine/core';
import { Badge, ThemeIcon } from '@mantine/core';
import { IconArrowRight } from '@tabler/icons-react';
import classes from './HoverActionButton.module.scss';
import clsx from 'clsx';

const CUSTOM_VARIANTS = ['white'] as const;
type CustomVariantType = (typeof CUSTOM_VARIANTS)[number];

const HoverActionButton = ({
  label,
  children,
  size,
  themeIconProps = {},
  color = 'green',
  variant = 'filled',
  onClick,
  keepIconOnHover = false,
  style,
  ...props
}: Props) => {
  const isCustomVariant = CUSTOM_VARIANTS.includes(color as CustomVariantType);
  const colorCustomVariant = color as CustomVariantType;

  return (
    <button
      style={{
        ...style,
        // @ts-ignore
        '--size': `${size}px`,
      }}
      onClick={onClick}
      className={clsx(classes.wrapper, isCustomVariant ? classes[colorCustomVariant] : undefined)}
      {...props}
    >
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
      {!keepIconOnHover && (
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
      )}
    </button>
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
  keepIconOnHover?: boolean;
};
export default HoverActionButton;
