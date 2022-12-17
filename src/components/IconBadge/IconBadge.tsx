import { Badge, BadgeProps, Tooltip } from '@mantine/core';

export function IconBadge({ icon, children, tooltip, ...props }: IconBadgeProps) {
  const badge = (
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

  if (!tooltip) return badge;

  return (
    <Tooltip label={tooltip} position="top" color="dark" withArrow>
      {badge}
    </Tooltip>
  );
}

type IconBadgeProps = {
  icon: React.ReactNode;
  tooltip?: string;
  onClick?: React.MouseEventHandler<any> | undefined;
} & Omit<BadgeProps, 'leftSection'>;
