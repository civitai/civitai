import { Badge, BadgeProps } from '@mantine/core';

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
      {...props}
    >
      {children}
    </Badge>
  );
}

type IconBadgeProps = {
  icon: React.ReactNode;
  children: React.ReactNode;
} & BadgeProps;
