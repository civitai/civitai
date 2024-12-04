import { Badge, BadgeProps, Tooltip } from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';

export function IconBadge({ icon, children, tooltip, href, ...props }: IconBadgeProps) {
  const badge = href ? (
    <Badge
      component={Link}
      href={href}
      styles={{
        leftSection: { marginRight: 4 },
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
        leftSection: { marginRight: 4 },
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

export type IconBadgeProps = {
  icon?: React.ReactNode;
  tooltip?: React.ReactNode;
  onClick?: React.MouseEventHandler<any> | undefined; //eslint-disable-line
  href?: string;
} & Omit<BadgeProps, 'leftSection'>;
