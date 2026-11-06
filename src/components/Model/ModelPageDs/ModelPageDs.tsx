import { Badge, Divider, Group, Stack, Text, Title } from '@mantine/core';
import clsx from 'clsx';
import type { CSSProperties, ReactNode } from 'react';
import { forwardRef } from 'react';
import type { DsBadgeColor, DsBadgeVariant } from '~/components/AppLayout/ShellDs/ContentDs';
import { DsBadge, DsBadgeLink, DsText, DsTitle } from '~/components/AppLayout/ShellDs/ContentDs';
import { ShellDivider } from '~/components/AppLayout/ShellDs/ShellDs';
import { ContainerGrid2 } from '~/components/ContainerGrid/ContainerGrid';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import classes from './ModelPageDs.module.css';

/**
 * The model page's layout and static badges with `modelPageDesignSystemMarkup` OFF (Mantine,
 * unchanged) and ON (`@civitai/components` markup). Each takes the flag as `ds` so the page states
 * its JSX once.
 */

const GAP = {
  xl: classes.gapXl,
  md: undefined,
  xs: classes.gapXs,
  0: classes.gap0,
  4: classes.gap4,
  6: classes.gap6,
  8: classes.gap8,
  12: classes.gap12,
} as const;
type Gap = keyof typeof GAP;

export function PageStack({
  ds,
  gap,
  className,
  children,
}: {
  ds: boolean;
  gap: Gap;
  className?: string;
  children: ReactNode;
}) {
  if (!ds)
    return (
      <Stack gap={gap} className={className}>
        {children}
      </Stack>
    );
  return <div className={clsx(classes.stack, GAP[gap], className)}>{children}</div>;
}

type PageGroupProps = {
  ds: boolean;
  gap?: Gap;
  align?: 'center' | 'flex-start';
  justify?: 'flex-start' | 'space-between';
  nowrap?: boolean;
  className?: string;
  children: ReactNode;
};

export function PageGroup({
  ds,
  gap = 'md',
  align = 'center',
  justify = 'flex-start',
  nowrap,
  className,
  children,
}: PageGroupProps) {
  if (!ds)
    return (
      <Group
        gap={gap}
        align={align}
        justify={justify}
        wrap={nowrap ? 'nowrap' : undefined}
        className={className}
      >
        {children}
      </Group>
    );
  return (
    <div
      className={clsx(
        classes.group,
        nowrap && classes.nowrap,
        align === 'flex-start' && classes.alignStart,
        justify === 'space-between' && classes.spaceBetween,
        GAP[gap],
        className
      )}
    >
      {children}
    </div>
  );
}

export function ModelTitle({
  ds,
  className,
  children,
}: {
  ds: boolean;
  className?: string;
  children: ReactNode;
}) {
  if (!ds)
    return (
      <Title className={className} order={1} lineClamp={2}>
        {children}
      </Title>
    );
  return <DsTitle className={className}>{children}</DsTitle>;
}

type ModelStatBadgeProps = {
  ds: boolean;
  icon: ReactNode;
  color?: 'gray' | 'green';
  className?: string;
  style?: CSSProperties;
  onClick?: React.MouseEventHandler<HTMLElement>;
  children: ReactNode;
};

/**
 * `IconBadge radius="sm" size="lg"`: the stats beside the model name. Forwards its ref and any
 * extra props, because the hover cards, `GenerateButton` and the tip button clone their child.
 */
export const ModelStatBadge = forwardRef<HTMLDivElement, ModelStatBadgeProps>(
  function ModelStatBadge({ ds, icon, color = 'gray', className, children, ...rest }, ref) {
    if (!ds)
      return (
        <IconBadge
          ref={ref}
          radius="sm"
          size="lg"
          color={color}
          icon={icon}
          className={className}
          {...rest}
        >
          {children}
        </IconBadge>
      );
    return (
      <DsBadge
        ref={ref}
        size="lg"
        color={color}
        leftSection={icon}
        className={clsx(classes.statBadge, className)}
        {...rest}
      >
        {children}
      </DsBadge>
    );
  }
);

export function ModelStatText({
  ds,
  className,
  children,
}: {
  ds: boolean;
  className: string;
  children: ReactNode;
}) {
  if (!ds) return <Text className={className}>{children}</Text>;
  return <DsText className={className}>{children}</DsText>;
}

export function UpdatedText({ ds, children }: { ds: boolean; children: ReactNode }) {
  if (!ds)
    return (
      <Text size="xs" c="dimmed">
        {children}
      </Text>
    );
  return (
    <DsText size="xs" dimmed>
      {children}
    </DsText>
  );
}

export function TagDivider({ ds }: { ds: boolean }) {
  return ds ? <ShellDivider /> : <Divider orientation="vertical" />;
}

export function CategoryBadge({ ds, name }: { ds: boolean; name: string }) {
  const href = `/tag/${encodeURIComponent(name.toLowerCase())}`;
  if (ds)
    return (
      <DsBadgeLink href={href} size="sm" color="blue" className="cursor-pointer">
        {name}
      </DsBadgeLink>
    );
  return (
    <Link href={href} legacyBehavior passHref>
      <Badge component="a" size="sm" color="blue" className="cursor-pointer">
        {name}
      </Badge>
    </Link>
  );
}

export function TagBadge({
  ds,
  name,
  colorScheme,
}: {
  ds: boolean;
  name: string;
  colorScheme: 'light' | 'dark';
}) {
  const href = `/tag/${encodeURIComponent(name.toLowerCase())}`;
  if (ds)
    return (
      <DsBadgeLink
        href={href}
        size="sm"
        color="gray"
        variant={colorScheme === 'dark' ? 'filled' : 'light'}
        className="cursor-pointer"
      >
        {name}
      </DsBadgeLink>
    );
  return (
    <Link legacyBehavior href={href} passHref>
      <Badge
        component="a"
        size="sm"
        color="gray"
        variant={colorScheme === 'dark' ? 'filled' : undefined}
        className="cursor-pointer"
      >
        {name}
      </Badge>
    </Link>
  );
}

export function PageText({
  ds,
  size,
  children,
}: {
  ds: boolean;
  size: 'xs' | 'sm';
  children: ReactNode;
}) {
  if (!ds) return <Text size={size}>{children}</Text>;
  return <DsText size={size}>{children}</DsText>;
}

/** A static Mantine `Badge`, or its design-system markup. `variant`/`radius` default to the theme's. */
export function ModelBadge({
  ds,
  color,
  variant,
  radius,
  size,
  children,
}: {
  ds: boolean;
  color: DsBadgeColor;
  variant?: DsBadgeVariant;
  radius?: 'sm' | 'xl';
  size?: 'sm' | 'md' | 'lg';
  children: ReactNode;
}) {
  if (!ds)
    return (
      <Badge color={color} variant={variant} radius={radius} size={size}>
        {children}
      </Badge>
    );
  return (
    <DsBadge color={color} variant={variant} radius={radius} size={size}>
      {children}
    </DsBadge>
  );
}

/**
 * The version page's `ContainerGrid2 gutter={{ base: 'xl', sm: 'sm', md: 'xl' }}`. The ON markup is
 * Mantine `Grid type="container"`'s own three wrappers, with its per-render `<style>` elements
 * replaced by static container queries in `ModelPageDs.module.css`. The container keeps Mantine's
 * name, `mantine-grid`, which `ModelVersionDetails.module.scss` queries.
 */
export function VersionDetailsGrid({ ds, children }: { ds: boolean; children: ReactNode }) {
  if (!ds)
    return <ContainerGrid2 gutter={{ base: 'xl', sm: 'sm', md: 'xl' }}>{children}</ContainerGrid2>;
  return (
    <div className={classes.gridContainer}>
      <div className={classes.gridRoot}>
        <div className={classes.gridInner}>{children}</div>
      </div>
    </div>
  );
}

type VersionDetailsColProps = {
  ds: boolean;
  /** `sidebar`: `span={{ base: 12, sm: 5, md: 4 }} order={{ sm: 2 }}`; `main`: 7 / 8, order 1. */
  side: 'sidebar' | 'main';
  className?: string;
  children: ReactNode;
};

export const VersionDetailsCol = forwardRef<HTMLDivElement, VersionDetailsColProps>(
  function VersionDetailsCol({ ds, side, className, children }, ref) {
    if (!ds)
      return (
        <ContainerGrid2.Col
          ref={ref}
          span={side === 'sidebar' ? { base: 12, sm: 5, md: 4 } : { base: 12, sm: 7, md: 8 }}
          order={side === 'sidebar' ? { sm: 2 } : { sm: 1 }}
          className={className}
        >
          {children}
        </ContainerGrid2.Col>
      );
    return (
      <div
        ref={ref}
        className={clsx(
          classes.gridCol,
          side === 'sidebar' ? classes.sidebarCol : classes.mainCol,
          className
        )}
      >
        {children}
      </div>
    );
  }
);
