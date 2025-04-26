import React from 'react';
import { useResizeObserver } from '~/hooks/useResizeObserver';
import { containerQuery } from '~/utils/mantine-css-helpers';
import styles from './ShowcaseGrid.module.scss';

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
  ...props
}: Props & { children: React.ReactNode; className?: string }) {
  const ref = useResizeObserver<HTMLDivElement>((entry) => {
    const children = [...entry.target.childNodes] as HTMLElement[];
    for (const child of children) {
      const { height } = child.getBoundingClientRect();
      if (height === 0) child.style.visibility = 'hidden';
      else child.style.removeProperty('visibility');
    }
  });

  if (props.carousel) {
    // Return a wrapped version:
    return (
      <div className={styles.container}>
        <div className={styles.scrollArea}>
          <div
            ref={ref}
            className={`${styles.grid} ${styles.gridCarousel} ${className}`}
            style={{ '--item-count': props.itemCount } as React.CSSProperties}
          >
            {children}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={ref}
      className={`${styles.grid} ${className}`}
      style={{ '--item-count': props.itemCount } as React.CSSProperties}
    >
      {children}
    </div>
  );
}
