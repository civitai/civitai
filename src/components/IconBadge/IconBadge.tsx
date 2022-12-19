import { Badge, BadgeProps, Tooltip } from '@mantine/core';
import { NextLink } from '@mantine/next';

export function IconBadge({ icon, children, tooltip, href, ...props }: IconBadgeProps) {
  const badge = href ? (
    <Badge
      component={NextLink}
      href={href}
      styles={{
        leftSection: { lineHeight: 1 },
        root: { paddingLeft: 3, paddingRight: 5, cursor: 'pointer' },
      }}
      radius="sm"
      color="gray"
      leftSection={icon}
      {...props}
    >
      {children}
    </Badge>
  ) : (
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
  onClick?: React.MouseEventHandler<any> | undefined; //eslint-disable-line
  href?: string;
} & Omit<BadgeProps, 'leftSection'>;
