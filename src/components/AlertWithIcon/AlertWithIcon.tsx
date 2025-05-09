import {
  Alert,
  AlertProps,
  Group,
  MantineColor,
  ThemeIcon,
  Text,
  Stack,
  MantineSize,
} from '@mantine/core';
import { ReactNode } from 'react';

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
              weight={500}
              color={props.color ?? 'blue'}
              sx={{ lineHeight: 1.1 }}
            >
              {title}
            </Text>
          )}
          <Text size={size} sx={{ lineHeight: 1.15 }}>
            {children}
          </Text>
        </Stack>
      </Group>
    </Alert>
  );
};

type AlertWithIconProps = AlertProps & {
  icon: ReactNode;
  iconColor?: MantineColor;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  iconSize?: MantineSize;
};

const titleSize: Record<NonNullable<AlertWithIconProps['size']>, MantineSize> = {
  xs: 'sm',
  sm: 'md',
  md: 'lg',
  lg: 'xl',
};
