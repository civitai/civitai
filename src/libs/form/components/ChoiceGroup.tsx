import { Tooltip } from '~/components/MantineOverlays';
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { Fragment, useRef, useState } from 'react';
import { useIsomorphicLayoutEffect } from '~/hooks/useIsomorphicLayoutEffect';
import { useResizeObserver } from '~/hooks/useResizeObserver';
import { choiceIdleClass, choiceSelectedClass } from './choice-styles';

export type ChoiceOption<T extends string | number = string> = {
  value: T;
  label: ReactNode;
  description?: string;
  disabled?: boolean;
};

type Props<T extends string | number> = {
  value?: T | null;
  onChange?: (value: T) => void;
  data: readonly (ChoiceOption<T> | T)[];
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
  /** Tapping the selected tile again, for a tile that opens something (the aspect ratio's Custom). */
  onReselect?: (value: T) => void;
  /** Tiles to a row, wrapping past it (default four). */
  columns?: number;
  /**
   * Columns that follow the width: up to this many to a row while every label fits on one line,
   * wrapping into balanced rows once one would not.
   */
  dynamicColumns?: number;
};

const COLUMNS = 4;
/** Must equal the grid's `gap-1.5`; the fit maths and OverflowSegmentedControl's More anchor use it. */
export const CHOICE_GROUP_GAP = 6;

/**
 * One of a few options as equal-width tiles: the generator's tile control for a pick-one. Four to a
 * row unless `columns` or `dynamicColumns` says otherwise.
 */
export function ChoiceGroup<T extends string | number>({
  value,
  onChange,
  data,
  disabled,
  className,
  'aria-label': ariaLabel,
  onReselect,
  columns = COLUMNS,
  dynamicColumns,
}: Props<T>) {
  const items = data.map((item) =>
    typeof item === 'object' ? item : { value: item, label: String(item) }
  );
  // Keyed on the values, not the array: callers build `data` afresh on every render.
  const perRow = useColumnsThatFit(dynamicColumns, items.length, [
    items.map((item) => item.value).join('|'),
    value,
  ]);

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      ref={perRow.ref}
      className={clsx('grid gap-1.5', className)}
      style={{
        gridTemplateColumns: `repeat(${
          dynamicColumns ? perRow.count : Math.min(items.length, columns)
        }, minmax(0, 1fr))`,
      }}
    >
      {items.map((item) => {
        const selected = item.value === value;
        const tile = (
          <button
            type="button"
            role="radio"
            aria-checked={selected}
            value={String(item.value)}
            disabled={disabled || item.disabled}
            data-tap-target
            onClick={() => (selected ? onReselect?.(item.value) : onChange?.(item.value))}
            className={clsx(
              'flex min-h-10 min-w-0 flex-col items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-center text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50',
              selected ? clsx(choiceSelectedClass, 'font-semibold') : choiceIdleClass
            )}
          >
            {item.label}
          </button>
        );
        return item.description ? (
          <Tooltip key={item.value} label={item.description} withinPortal position="bottom">
            {tile}
          </Tooltip>
        ) : (
          <Fragment key={item.value}>{tile}</Fragment>
        );
      })}
    </div>
  );
}

/**
 * How many tiles to a row for `dynamicColumns`: as many as fit with every label on one line, at
 * most that many, spread evenly over the rows they need (six that fit five to a row go three and three).
 * The widest label is measured before paint by laying the tiles out at their natural width; the
 * row's own width is watched, so a sidebar being resized re-fits it.
 */
function useColumnsThatFit(
  columns: number | undefined,
  count: number,
  /** What can change a label's width: the options, and the selection (the selected tile is bold). */
  remeasureOn: unknown[]
) {
  const widest = useRef(0);
  const cap = Math.min(count, columns ?? count);
  const [fitted, setFitted] = useState(cap);

  const measure = (el: HTMLElement) => {
    const template = el.style.gridTemplateColumns;
    el.style.gridTemplateColumns = `repeat(${count}, max-content)`;
    widest.current = Math.max(
      ...Array.from(el.children, (tile) => tile.getBoundingClientRect().width)
    );
    el.style.gridTemplateColumns = template;
  };

  const fit = () => {
    const el = ref.current;
    if (!el || !columns) return;
    // Mounted hidden, it measured nothing; measure again now there is a width.
    if (!widest.current) measure(el);
    if (!widest.current) return;
    const room = Math.floor(
      (el.clientWidth + CHOICE_GROUP_GAP) / (widest.current + CHOICE_GROUP_GAP)
    );
    const perRow = Math.max(1, Math.min(cap, room));
    setFitted(Math.ceil(count / Math.ceil(count / perRow)));
  };

  const ref = useResizeObserver<HTMLDivElement>(fit);

  useIsomorphicLayoutEffect(() => {
    const el = ref.current;
    if (!el || !columns) return;
    measure(el);
    fit();
  }, [columns, count, ...remeasureOn]); // eslint-disable-line react-hooks/exhaustive-deps

  return { ref, count: fitted };
}
