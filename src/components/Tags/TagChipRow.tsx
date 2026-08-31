import { Button, useComputedColorScheme } from '@mantine/core';
import clsx from 'clsx';

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

function TagChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  const colorScheme = useComputedColorScheme('dark');

  // In dark mode every chip is `filled`, so colour is the only thing separating active
  // from inactive there.
  return (
    <Button
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
      {!loading && (
        <TwScrollX className="flex gap-1">
          {includeAll && <TagChip label="All" active={activeId === undefined} onClick={onClear} />}
          {items.map((item) => (
            <TagChip
              key={item.id}
              label={item.label}
              active={activeId === item.id}
              onClick={() => onSelect(item)}
            />
          ))}
        </TwScrollX>
      )}
    </div>
  );
}
