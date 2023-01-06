import { Alert, AlertProps, Group, MantineColor, ThemeIcon, Text } from '@mantine/core';
import { ReactNode } from 'react';

export const AlertWithIcon = ({ icon, iconColor, children, ...props }: AlertWithIconProps) => {
  return (
    <Alert radius="sm" pl={10} {...props}>
      <Group spacing="xs" noWrap>
        <ThemeIcon color={iconColor}>{icon}</ThemeIcon>
        <Text size="xs" sx={{ lineHeight: 1.1 }}>
          {children}
        </Text>
      </Group>
    </Alert>
  );
};

type AlertWithIconProps = AlertProps & {
  icon: ReactNode;
  iconColor?: MantineColor;
};
