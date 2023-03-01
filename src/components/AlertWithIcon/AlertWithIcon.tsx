import { Alert, AlertProps, Group, MantineColor, ThemeIcon, Text, Stack } from '@mantine/core';
import { MantineNumberSize } from '@mantine/styles';
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
      <Group spacing="xs" noWrap>
        <ThemeIcon color={iconColor} size={iconSize}>
          {icon}
        </ThemeIcon>
        <Stack spacing={0}>
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
          <Text size={size} sx={{ lineHeight: 1.1 }}>
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
  iconSize?: MantineNumberSize;
};

const titleSize: Record<NonNullable<AlertWithIconProps['size']>, MantineNumberSize> = {
  xs: 'sm',
  sm: 'md',
  md: 'lg',
  lg: 'xl',
};
