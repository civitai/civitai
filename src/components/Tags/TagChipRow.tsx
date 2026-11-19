import { Button, useComputedColorScheme } from '@mantine/core';
import clsx from 'clsx';
import type { ReactNode } from 'react';

import { TwScrollX } from '~/components/TwScrollX/TwScrollX';

// Mantine's `--button-height-compact-sm`, which is the size every chip below uses.
//
// 🔴 This number and that size are one fact in two places, and they have already drifted
// apart once: the fix that reserves the row lived in the deleted `TagScroller`, so
// `CategoryTags` never had it and the row popped in above the feed — the 0.65 CLS on
// /images that `docs/cls-remediation-plan.md` measured. Both the empty and populated
// states carry the reservation, because a row that collapses when it holds no chips
// shifts the feed exactly as badly as one that appears late.
const CHIP_ROW_MIN_HEIGHT = 'min-h-[26px]';

/**
 * Pencil `m52ee` (the music surfaces): sentence case, 26px pills, outlined until picked. Its
 * height matches the default chip's, so the row reservation below holds for both.
 */
function OutlineTagChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-active={active || undefined}
      onClick={onClick}
      className={clsx(
        'h-[26px] shrink-0 whitespace-nowrap rounded-full border border-solid px-3 text-[13px] font-medium leading-4',
        active
          ? 'border-transparent bg-blue-1 text-blue-7 dark:bg-blue-8/20 dark:text-blue-3'
          : 'border-gray-3 text-black hover:bg-gray-1 dark:border-dark-4 dark:text-dark-0 dark:hover:bg-dark-5'
      )}
    >
      {label}
    </button>
  );
}

function TagChip({
  label,
  active,
  onClick,
  variant,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  variant: TagChipVariant;
}) {
  const colorScheme = useComputedColorScheme('dark');
  if (variant === 'outline')
    return <OutlineTagChip label={label} active={active} onClick={onClick} />;

  // In dark mode every chip is `filled`, so colour is the only thing separating active
  // from inactive there.
  //
  // `data-active` is for tests, and it is here rather than in a test helper on purpose: a
  // suite that reads selection back out of Mantine's `--button-bg` colour token is
  // asserting on a THEME, and the day that token is renamed or emitted as a hex, every
  // such assertion returns "nothing is selected" and passes. This attribute is the
  // `active` prop itself, so it cannot drift from it.
  return (
    <Button
      data-active={active || undefined}
      className="overflow-visible uppercase"
      variant={active ? 'filled' : colorScheme === 'dark' ? 'filled' : 'light'}
      color={active ? 'blue' : 'gray'}
      onClick={onClick}
      size="compact-sm"
    >
      {label}
    </Button>
  );
}

export type TagChipRowItem = { id: number | string; label: string };
export type TagChipVariant = 'default' | 'outline';

/**
 * The chip row every tag filter bar is made of — the scroller, the height reservation,
 * the optional All chip and the chips themselves.
 *
 * Shared because this row existed as two hand-maintained copies (`CategoryTags` and the
 * deleted `TagScroller`) and the CLS fix went missing between them. Callers own the URL:
 * what a chip means, and where the selection is stored, differs per surface.
 */
export function TagChipRow({
  items,
  activeId,
  onSelect,
  onClear,
  includeAll = true,
  loading = false,
  placeholder = null,
  variant = 'default',
}: {
  items: TagChipRowItem[];
  /** `undefined` means nothing is selected, which is what fills the All chip. */
  activeId?: number | string;
  onSelect: (item: TagChipRowItem) => void;
  onClear: () => void;
  includeAll?: boolean;
  /**
   * Render the reservation and no chips. The CALLER decides this rather than the row
   * inferring it from `items.length`: a caller that filters its own list can legitimately
   * end up with zero chips and still want the All chip rendered, and that is what
   * `CategoryTags` did before this row was extracted.
   */
  loading?: boolean;
  /**
   * What to draw in the reservation while `loading`. It goes INSIDE the reserved height
   * rather than beside the row, so a caller substituting a control for the chips does not
   * add height the reservation was sized without — which is the shift this row exists to
   * prevent, arriving by the other door.
   */
  placeholder?: ReactNode;
  variant?: TagChipVariant;
}) {
  // The reservation sits on ONE wrapper both branches share, rather than on the
  // placeholder and the scroller separately. Two elements holding the same height is a
  // coupling nothing points at: give `TwScrollX` a border or padding later and the loaded
  // branch grows while the placeholder does not, and the shift comes back.
  //
  // `min-w-0` because this wrapper is a flex item in the resource-select modal. Callers
  // used to put `TwScrollX` there directly, and its `overflow-hidden` bought the automatic
  // `min-width: 0` that lets the row shrink and scroll instead of pushing its siblings out.
  return (
    <div className={clsx('min-w-0', CHIP_ROW_MIN_HEIGHT)}>
      {loading ? (
        placeholder
      ) : (
        <TwScrollX className={clsx('flex', variant === 'outline' ? 'gap-2' : 'gap-1')}>
          {includeAll && (
            <TagChip
              label="All"
              active={activeId === undefined}
              onClick={onClear}
              variant={variant}
            />
          )}
          {items.map((item) => (
            <TagChip
              key={item.id}
              label={item.label}
              active={activeId === item.id}
              onClick={() => onSelect(item)}
              variant={variant}
            />
          ))}
        </TwScrollX>
      )}
    </div>
  );
}
