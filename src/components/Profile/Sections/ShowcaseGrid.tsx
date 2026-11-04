import type { CSSProperties } from 'react';
import React from 'react';
import { useResizeObserver } from '~/hooks/useResizeObserver';
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
  // A card in a collapsed row still paints its hat into the clip's hat room, so it is hidden.
  // Watched per card: a card can drop into a collapsed row without the grid changing size.
  const ref = useResizeObserver<HTMLDivElement>(
    (entry) => {
      const child = entry.target as HTMLElement;
      if (child.getBoundingClientRect().height === 0) child.style.visibility = 'hidden';
      else child.style.removeProperty('visibility');
    },
    { observeChildren: true }
  );

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
