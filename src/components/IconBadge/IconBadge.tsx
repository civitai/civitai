import { Badge, BadgeProps, Button } from '@mantine/core';

export function IconBadge({ icon, children, ...props }: IconBadgeProps) {
  return (
    <Badge
      styles={{
        leftSection: { lineHeight: 1 },
        root: { paddingLeft: 3, paddingRight: 5 },
      }}
      radius="sm"
      color="gray"
      leftSection={icon}
      component={Button}
      {...props}
    >
      {children}
    </Badge>
  );
}

type IconBadgeProps = {
  icon: React.ReactNode;
  onClick?: React.MouseEventHandler<any> | undefined;
  disabled?: boolean;
} & Omit<BadgeProps, 'leftSection'>;
