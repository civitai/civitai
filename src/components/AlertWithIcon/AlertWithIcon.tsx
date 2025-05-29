import type { AlertProps, MantineColor, MantineSize, ThemeIconProps } from '@mantine/core';
import { Alert, Group, ThemeIcon, Text, Stack } from '@mantine/core';
import type { ReactNode } from 'react';

export const AlertWithIcon = ({
  icon,
  iconColor,
  children,
  title,
  size = 'xs',
  iconSize,
  ...props
}: AlertWithIconProps) => {
  return (
    <Alert radius="sm" pl={10} {...props}>
      <Group gap="xs" wrap="nowrap">
        <ThemeIcon color={iconColor} size={iconSize}>
          {icon}
        </ThemeIcon>
        <Stack gap={0}>
          {title && (
            <Text
              size={titleSize[size]}
              fw={500}
              c={props.color ?? 'blue'}
              style={{ lineHeight: 1.1 }}
            >
              {title}
            </Text>
          )}
          {typeof children === 'string' ? (
            <Text size={size} style={{ lineHeight: 1.15 }}>
              {children}
            </Text>
          ) : (
            children
          )}
        </Stack>
      </Group>
    </Alert>
  );
};

type AlertWithIconProps = AlertProps & {
  icon: ReactNode;
  iconColor?: MantineColor;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  iconSize?: ThemeIconProps['size'];
};

const titleSize: Record<NonNullable<AlertWithIconProps['size']>, MantineSize> = {
  xs: 'sm',
  sm: 'md',
  md: 'lg',
  lg: 'xl',
};
