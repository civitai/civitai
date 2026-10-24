import type { GroupProps } from '@mantine/core';
import { Group } from '@mantine/core';
import clsx from 'clsx';

/**
 * A page's own bottom bar for its primary actions (Save, Cancel), standing in for the app footer:
 * register the page with `footer: null` and render this inside its content. It sticks to the
 * bottom edge, bleeds its border and background to the viewport while the buttons stay in the
 * page column, and carries the same `data-app-footer` mark as the app footer so page content stops
 * paying the bottom inset.
 */
export function PageActionBar({ className, children, ...props }: GroupProps) {
  return (
    <Group
      justify="flex-end"
      data-app-footer=""
      className={clsx(
        'pb-safe-bar sticky bottom-0 z-10 py-3',
        "before:absolute before:inset-y-0 before:left-[calc(50%-50vw)] before:right-[calc(50%-50vw)] before:-z-10 before:border-t before:border-gray-3 before:bg-white before:content-[''] dark:before:border-dark-4 dark:before:bg-dark-7",
        className
      )}
      {...props}
    >
      {children}
    </Group>
  );
}
