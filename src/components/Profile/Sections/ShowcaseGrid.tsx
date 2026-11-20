import type { CSSProperties } from 'react';
import { Button } from '@mantine/core';
import React, { useEffect, useRef, useState } from 'react';
import { RemixFlyoutLayoutProvider } from '~/components/RemixGallery/remix-flyout-layout';
import classes from './ShowcaseGrid.module.scss';
import clsx from 'clsx';

type Props = {
  itemCount: number;
  rows: number;
  minWidth?: number;
  defaultWidth?: number;
  carousel?: boolean;
  /** Told how many items the row clip hides, each time that changes. */
  onHiddenCountChange?: (hidden: number) => void;
};

export function ShowcaseGrid({
  children,
  className,
  itemCount,
  rows,
  minWidth = 280,
  defaultWidth = 280,
  onHiddenCountChange,
  ...props
}: Props & { children: React.ReactNode; className?: string }) {
  const onHidden = useRef(onHiddenCountChange);
  onHidden.current = onHiddenCountChange;
  // A card in a collapsed row still paints its hat into the clip's hat room, so it is hidden. An
  // image card keeps its aspect-ratio height in a 0px row and can drop into one without resizing.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const grid = ref.current;
    if (!grid) return;
    const update = () => {
      const bottom = grid.getBoundingClientRect().bottom;
      let hidden = 0;
      for (const child of grid.children as HTMLCollectionOf<HTMLElement>) {
        const box = child.getBoundingClientRect();
        if (box.height === 0 || box.top >= bottom) {
          child.style.visibility = 'hidden';
          hidden++;
        } else child.style.removeProperty('visibility');
      }
      onHidden.current?.(hidden);
    };
    const resize = new ResizeObserver(update);
    resize.observe(grid);
    for (const child of grid.children) resize.observe(child);
    const mutation = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) if (node instanceof Element) resize.observe(node);
        for (const node of record.removedNodes) if (node instanceof Element) resize.unobserve(node);
      }
      update();
    });
    mutation.observe(grid, { childList: true });
    return () => {
      resize.disconnect();
      mutation.disconnect();
    };
  }, []);

  const styleVars = {
    '--item-count': itemCount,
    '--rows': rows,
    '--min-width': `${minWidth}px`,
    '--default-width': `${defaultWidth}px`,
  } as CSSProperties;

  // A shelf is a fixed row count inside `overflow: hidden`, so a flyout leaving
  // a card downward is cut off by whatever sits under the section. Home-block
  // shelves are the same shape and declare the same layout.
  const content = <RemixFlyoutLayoutProvider layout="side">{children}</RemixFlyoutLayoutProvider>;

  if (props.carousel) {
    // Return a wrapped version:
    return (
      <div style={styleVars} className={classes.container}>
        <div className={classes.scrollArea}>
          <div ref={ref} className={clsx(classes.grid, classes.gridCarousel, className)}>
            {content}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={styleVars} ref={ref} className={clsx(classes.grid, className)}>
      {content}
    </div>
  );
}

/**
 * A shelf's "View all": while the grid's row clip hides items, a toggle unfolds every item in place.
 * The count is not re-read while unfolded (nothing is hidden then), so "Show less" stays mounted.
 */
export function useShowcaseViewAll({ rows, itemCount }: { rows: number; itemCount: number }) {
  const [hidden, setHidden] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const gridProps = {
    // Unfolded, every item gets a row: the grid's empty rows take no height.
    rows: expanded ? itemCount : rows,
    onHiddenCountChange: expanded ? undefined : setHidden,
  };
  const toggle =
    hidden > 0 || expanded ? (
      <div className="flex justify-center">
        <Button
          variant="subtle"
          size="compact-sm"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? 'Show less' : `View all ${itemCount}`}
        </Button>
      </div>
    ) : null;
  return { gridProps, toggle };
}
