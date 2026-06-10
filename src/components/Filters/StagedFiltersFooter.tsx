import { Button, Group, Stack, useComputedColorScheme } from '@mantine/core';
import clsx from 'clsx';

export type StagedFiltersFooterProps = {
  isDirty: boolean;
  onApply: () => void;
  onReset: () => void;
  // When >0 and `onClear` is provided, the "Clear all filters" button shows
  // below the Apply/Reset row. Matches the legacy footer behaviour each
  // dropdown had before staging was introduced.
  filterLength?: number;
  onClear?: () => void;
  applyLabel?: string;
  resetLabel?: string;
  className?: string;
};

// Renders edge-to-edge with its own padding, border-top, and background so it
// reads as a footer band regardless of the surrounding scroll/non-scroll
// container. Consumers must place this as a direct child of a `p=0` container
// (Popover.Dropdown / Drawer body / Stack) so the band hugs the dropdown
// edges; do not nest inside a padded Stack.
export function StagedFiltersFooter({
  isDirty,
  onApply,
  onReset,
  filterLength = 0,
  onClear,
  applyLabel = 'Apply filters',
  resetLabel = 'Reset',
  className,
}: StagedFiltersFooterProps) {
  const colorScheme = useComputedColorScheme('dark');

  return (
    <Stack
      gap="xs"
      className={clsx(
        // Sticky bottom-0 pins the footer to the nearest scrolling ancestor.
        // On desktop the footer is a sibling of the scrolling ScrollArea so
        // sticky is inert (parent doesn't scroll); on mobile the Drawer body
        // scrolls and the footer pins to its bottom, keeping Apply reachable
        // without scrolling to the end of the filter list.
        'sticky bottom-0 z-10 border-t border-gray-3 bg-white px-4 py-3 dark:border-dark-4 dark:bg-dark-7',
        className
      )}
    >
      <Group grow>
        <Button variant="default" onClick={onReset} disabled={!isDirty}>
          {resetLabel}
        </Button>
        <Button onClick={onApply} disabled={!isDirty}>
          {applyLabel}
        </Button>
      </Group>
      {filterLength > 0 && onClear && (
        <Button
          color="gray"
          variant={colorScheme === 'dark' ? 'filled' : 'light'}
          onClick={onClear}
          fullWidth
        >
          Clear all filters
        </Button>
      )}
    </Stack>
  );
}
