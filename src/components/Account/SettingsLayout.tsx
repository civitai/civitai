import { Text } from '@mantine/core';
import clsx from 'clsx';
import React from 'react';

/**
 * The settings panes deliberately carry no `Card`. Twenty-three bordered boxes stacked down a page
 * is what made the old one read as a pile; sections separated by a rule and a heading give the same
 * grouping without the chrome, and let two columns line up on a shared baseline.
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
      <div className="flex flex-col divide-y divide-gray-3 border-t border-gray-3 dark:divide-dark-4 dark:border-dark-4">
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

/** Two columns from `md` up, each column a stack of sections on a shared baseline. */
export function SettingsColumns({
  left,
  right,
}: {
  left: React.ReactNode;
  right: React.ReactNode;
}) {
  return (
    <div className="grid items-start gap-x-10 gap-y-8 md:grid-cols-2">
      <div className="flex flex-col gap-8">{left}</div>
      <div className="flex flex-col gap-8">{right}</div>
    </div>
  );
}
