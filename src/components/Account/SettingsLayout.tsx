import { Card as MantineCard, Stack, Text, Title } from '@mantine/core';
import clsx from 'clsx';
import React from 'react';

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
  title?: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={clsx('flex flex-col', className)}>
      {(title || action) && (
        <div className="flex items-start justify-between gap-3 pb-2">
          <div className="flex min-w-0 flex-col gap-0.5">
            {title && (
              <Text component="h2" className="text-base font-semibold leading-tight">
                {title}
              </Text>
            )}
            {description && (
              <Text size="xs" c="dimmed" className="leading-snug">
                {description}
              </Text>
            )}
          </div>
          {action}
        </div>
      )}
      <div
        className={clsx(
          'flex flex-col divide-y divide-gray-3 border-t border-gray-3 dark:divide-dark-4 dark:border-dark-4',
          // Mantine puts a Switch's track before its label. Every other control in a settings row
          // reads label-left / control-right, and a section that mixes both alignments is the thing
          // the design review rejected. Reversing the body here keeps one implementation of each
          // toggle instead of a settings-only copy. Static slot classes are load-bearing across this
          // repo already — see the `getStaticClassNames` note in globals.css.
          '[&_.mantine-Switch-body]:w-full [&_.mantine-Switch-body]:flex-row-reverse [&_.mantine-Switch-body]:items-center [&_.mantine-Switch-body]:justify-between [&_.mantine-Switch-body]:gap-6',
          '[&_.mantine-Switch-labelWrapper]:flex-1'
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
      <div className="flex flex-col gap-2 py-3">
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
    <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
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
      {control && <div className="shrink-0 sm:min-w-[180px] sm:text-right">{control}</div>}
    </div>
  );
}

/**
 * Panes are a single column. Two columns were tried and dropped: without card edges there is no
 * boundary telling you which column to read first, and the pairing only ever saved height on three
 * of eight panes.
 */
export function SettingsStack({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-8">{children}</div>;
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
  title?: string;
  description?: string;
  action?: React.ReactNode;
  id?: string;
  children: React.ReactNode;
}) {
  if (flat)
    return (
      <div id={id}>
        <SettingsSection title={title} description={description} action={action}>
          {children}
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
