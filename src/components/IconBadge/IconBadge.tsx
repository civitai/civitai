import type { BadgeProps } from '@mantine/core';
import { Badge, Tooltip } from '@mantine/core';
import { forwardRef } from 'react';
import { NextLink as Link } from '~/components/NextLink/NextLink';

export const IconBadge = forwardRef<HTMLDivElement, IconBadgeProps>(
  ({ icon, children, tooltip, href, ...props }, ref) => {
    const badge = href ? (
      <Badge
        ref={ref as any}
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
        ref={ref}
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
);

IconBadge.displayName = 'IconBadge';

export type IconBadgeProps = {
  icon?: React.ReactNode;
  tooltip?: React.ReactNode;
  onClick?: React.MouseEventHandler<any> | undefined; //eslint-disable-line
  href?: string;
} & Omit<BadgeProps, 'leftSection'>;
