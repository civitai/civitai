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
  align = 'left',
  ...props
}: AlertWithIconProps) => {
  const message =
    typeof children === 'string' ? (
      <Text size={size} style={{ lineHeight: align === 'center' ? 1.3 : 1.15 }}>
        {children}
      </Text>
    ) : (
      children
    );

  // Centered variant: circular icon stacked above a centered title + message.
  // Reusable for empty-state / callout styling where the standard left-aligned
  // alert reads as too utilitarian.
  if (align === 'center') {
    return (
      <Alert radius="sm" {...props}>
        <Stack gap={8} align="center" style={{ textAlign: 'center' }}>
          <ThemeIcon color={iconColor} size={iconSize ?? 48} variant="light" radius="xl">
            {icon}
          </ThemeIcon>
          {title && (
            <Text
              size={titleSize[size]}
              fw={600}
              c={props.color ?? 'blue'}
              style={{ lineHeight: 1.1 }}
            >
              {title}
            </Text>
          )}
          {message}
        </Stack>
      </Alert>
    );
  }

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
          {message}
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
  /** `center` stacks a circular icon above centered title/text (callout style). */
  align?: 'left' | 'center';
};

const titleSize: Record<NonNullable<AlertWithIconProps['size']>, MantineSize> = {
  xs: 'sm',
  sm: 'md',
  md: 'lg',
  lg: 'xl',
};
