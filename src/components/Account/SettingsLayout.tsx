import { Card as MantineCard, Group, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { IconArrowUpRight, IconCircleCheck } from '@tabler/icons-react';
import clsx from 'clsx';
import React from 'react';

import { NextLink } from '~/components/NextLink/NextLink';

/**
 * The settings panes deliberately carry no `Card`. Twenty-three bordered boxes stacked down a page
 * is what made the old one read as a pile; sections separated by a rule and a heading give the same
 * grouping without the chrome.
 */
export function SettingsSection({
  title,
  description,
  action,
  children,
  className,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={clsx('flex flex-col', className)}>
      {(title || description || action) && (
        <div className="flex flex-col gap-0.5 pb-2">
          {(title || action) && (
            <div className="flex items-center justify-between gap-3">
              {title && (
                <Text component="h2" className="text-base font-semibold leading-tight">
                  {title}
                </Text>
              )}
              {action && <div className="shrink-0">{action}</div>}
            </div>
          )}
          {description && (
            <Text size="xs" c="dimmed" className="leading-snug">
              {description}
            </Text>
          )}
        </div>
      )}
      <div
        className={clsx(
          'flex flex-col gap-5 border-t border-gray-3 pt-4 dark:border-dark-4',
          // Mantine puts a Switch's track before its label. Every other control in a settings row
          // reads label-left / control-right, and a section that mixes both alignments is the thing
          // the design review rejected. Reversing the body here keeps one implementation of each
          // toggle instead of a settings-only copy. Static slot classes are load-bearing across this
          // repo already — see the `getStaticClassNames` note in globals.css.
          '[&_.mantine-Switch-body]:w-full [&_.mantine-Switch-body]:flex-row-reverse [&_.mantine-Switch-body]:items-center [&_.mantine-Switch-body]:justify-between [&_.mantine-Switch-body]:gap-6',
          '[&_.mantine-Switch-labelWrapper]:flex-1',
          // Mantine's label padding is the gap to the track. Reversed, it becomes an indent off
          // the row column.
          '[&_.mantine-Switch-description]:ps-0 [&_.mantine-Switch-label]:ps-0'
        )}
      >
        {children}
      </div>
    </section>
  );
}

/**
 * `control` sits right of the label on a wide row and drops beneath it on a narrow one. Anything
 * that needs the full width regardless — a tag picker, a list — should use `block` instead.
 */
export function SettingRow({
  label,
  description,
  control,
  block,
  children,
}: {
  label?: React.ReactNode;
  description?: React.ReactNode;
  control?: React.ReactNode;
  block?: boolean;
  children?: React.ReactNode;
}) {
  if (block) {
    return (
      <div className="flex flex-col gap-2">
        {(label || description) && (
          <div className="flex flex-col gap-0.5">
            {label && (
              <Text size="sm" fw={500}>
                {label}
              </Text>
            )}
            {description && (
              <Text size="xs" c="dimmed" className="leading-snug">
                {description}
              </Text>
            )}
          </div>
        )}
        {children ?? control}
      </div>
    );
  }

  return (
    <div
      className={clsx(
        'flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-6',
        // Stacking put the track under the description, where it read as the next row's.
        'has-[.mantine-Switch-root]:flex-row has-[.mantine-Switch-root]:items-center has-[.mantine-Switch-root]:justify-between has-[.mantine-Switch-root]:gap-4'
      )}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        {label && (
          <Text size="sm" fw={500}>
            {label}
          </Text>
        )}
        {description && (
          <Text size="xs" c="dimmed" className="leading-snug">
            {description}
          </Text>
        )}
      </div>
      {control && (
        // `[&>*]:ml-auto` for block controls that shrink to content — a switch, or the
        // fixed-width Skeleton around one.
        <div
          className={clsx(
            'shrink-0 text-right sm:min-w-[180px] [&>*]:ml-auto',
            // The section's Switch overrides target switches that ARE the row. A switch in
            // `control` has no label, so they stretch it past the section's edge — undo them and
            // let it shrink to the track.
            '[&_.mantine-Switch-body]:!w-auto [&_.mantine-Switch-body]:!flex-row [&_.mantine-Switch-body]:!gap-0 [&_.mantine-Switch-root]:!w-fit'
          )}
        >
          {control}
        </div>
      )}
    </div>
  );
}

/**
 * Panes are a single column. Two columns were tried and dropped: without card edges there is no
 * boundary telling you which column to read first, and the pairing only ever saved height on three
 * of eight panes.
 */
export function SettingsStack({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-10">{children}</div>;
}

/**
 * Cards that predate the flat panes take a `flat` prop rather than being forked: the legacy page
 * still mounts them inside `Card` chrome while the flag is alive, and two copies of a settings form
 * is exactly how one of them silently loses a field.
 */
export function CardOrSection({
  flat,
  title,
  description,
  action,
  id,
  children,
}: {
  flat?: boolean;
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  id?: string;
  children: React.ReactNode;
}) {
  if (flat)
    return (
      <div id={id}>
        <SettingsSection title={title} description={description} action={action}>
          <Stack>{children}</Stack>
        </SettingsSection>
      </div>
    );

  return (
    <MantineCard withBorder id={id}>
      <Stack>
        {title && <Title order={2}>{title}</Title>}
        {children}
      </Stack>
    </MantineCard>
  );
}

export function SettingsNote({
  icon,
  children,
}: {
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 rounded-md bg-blue-1 px-4 py-3 dark:bg-blue-8/20">
      {icon && <div className="shrink-0 text-blue-6">{icon}</div>}
      <Text size="sm" className="leading-snug">
        {children}
      </Text>
    </div>
  );
}

/** A row that sends you somewhere else rather than changing anything here. */
export function PointerCard({
  icon,
  title,
  description,
  href,
  action,
  tone = 'default',
}: {
  icon: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  href?: string;
  action?: React.ReactNode;
  tone?: 'default' | 'danger';
}) {
  const danger = tone === 'danger';
  const body = (
    <>
      <div className="flex items-center gap-3.5">
        <div
          className={clsx(
            'flex size-9 shrink-0 items-center justify-center rounded',
            danger
              ? 'bg-red-1 text-red-6 dark:bg-red-8/25'
              : 'bg-blue-1 text-blue-6 dark:bg-blue-8/25'
          )}
        >
          {icon}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <Text size="sm" fw={600}>
            {title}
          </Text>
          {description && (
            <Text size="xs" c="dimmed" className="leading-snug">
              {description}
            </Text>
          )}
        </div>
        {!action && (
          <IconArrowUpRight size={16} className="shrink-0 text-gray-6 dark:text-dark-2" />
        )}
      </div>
      {action && <div className="shrink-0 self-end sm:self-auto">{action}</div>}
    </>
  );

  const className = clsx(
    'flex flex-col gap-3 rounded-md border p-4 no-underline sm:flex-row sm:items-center sm:gap-3.5',
    '[&>div:first-child]:min-w-0 [&>div:first-child]:flex-1',
    danger
      ? 'border-red-6 bg-red-1/50 dark:bg-red-8/10'
      : 'border-gray-3 bg-white dark:border-dark-4 dark:bg-dark-6'
  );

  if (href)
    return (
      <NextLink href={href} className={clsx(className, 'hover:bg-gray-0 dark:hover:bg-dark-5')}>
        {body}
      </NextLink>
    );

  return <div className={className}>{body}</div>;
}

/**
 * The gate a settings pane shows instead of controls the user cannot use yet. One implementation
 * because the three sites that need it (metric visibility, membership, payouts) sit in different
 * cards and would otherwise drift apart in tone.
 */
export function UpsellPanel({
  icon,
  title,
  description,
  perks,
  action,
}: {
  icon: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  perks?: React.ReactNode[];
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-gray-2 bg-gray-0 p-6 text-center dark:border-dark-4 dark:bg-dark-5">
      <ThemeIcon size={48} variant="light" color="gray" radius="xl">
        {icon}
      </ThemeIcon>
      <Text fw={700} size="lg">
        {title}
      </Text>
      {description && (
        <Text size="sm" c="dimmed" maw={380}>
          {description}
        </Text>
      )}
      {!!perks?.length && (
        <Stack gap={6} align="flex-start" ta="left">
          {perks.map((perk, index) => (
            <Group key={index} gap={8} wrap="nowrap">
              <IconCircleCheck
                size={16}
                className="shrink-0"
                style={{ color: 'var(--mantine-color-green-6)' }}
              />
              <Text size="sm">{perk}</Text>
            </Group>
          ))}
        </Stack>
      )}
      {action}
    </div>
  );
}
