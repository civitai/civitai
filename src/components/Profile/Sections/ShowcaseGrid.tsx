import type { CSSProperties } from 'react';
import React, { useEffect, useRef } from 'react';
import { RemixFlyoutLayoutProvider } from '~/components/RemixGallery/remix-flyout-layout';
import classes from './ShowcaseGrid.module.scss';
import clsx from 'clsx';

type Props = {
  itemCount: number;
  rows: number;
  minWidth?: number;
  defaultWidth?: number;
  carousel?: boolean;
};

export function ShowcaseGrid({
  children,
  className,
  itemCount,
  rows,
  minWidth = 280,
  defaultWidth = 280,
  ...props
}: Props & { children: React.ReactNode; className?: string }) {
  // A card in a collapsed row still paints its hat into the clip's hat room, so it is hidden. An
  // image card keeps its aspect-ratio height in a 0px row and can drop into one without resizing.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const grid = ref.current;
    if (!grid) return;
    const update = () => {
      const bottom = grid.getBoundingClientRect().bottom;
      for (const child of grid.children as HTMLCollectionOf<HTMLElement>) {
        const box = child.getBoundingClientRect();
        if (box.height === 0 || box.top >= bottom) child.style.visibility = 'hidden';
        else child.style.removeProperty('visibility');
      }
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
