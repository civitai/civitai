import React from 'react';
import { useResize } from './useResize';
import classes from './ResizeableSidebar.module.scss';
import cx from 'clsx';

export type ResizableSidebarProps = {
  resizePosition: 'left' | 'right'; // maybe rename to 'position'?
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  name: string;
};

export function ResizableSidebar({
  children,
  resizePosition,
  minWidth,
  maxWidth,
  defaultWidth,
  name,
  ...props
}: ResizableSidebarProps) {
  // const { classes, cx } = useStyles({ resizeFrom: resizePosition });
  const { containerRef, resizerRef } = useResize({
    resizePosition,
    minWidth,
    maxWidth,
    defaultWidth,
    name,
  });

  const resizer = <div className={classes.resizer} ref={resizerRef} />;

  return (
    <div
      {...props}
      style={{
        // Seed --sidebar-default-width so the CSS rule `width: var(--sidebar-default-width)`
        // on .sidebar reserves space in the SSR HTML / first paint.  After mount, useResize
        // sets element.style.width directly (inline style wins over stylesheet), so resize
        // behaviour is unaffected and React re-renders never stomp the user's dragged width.
        ...(defaultWidth !== undefined && {
          '--sidebar-default-width': `${defaultWidth}px`,
        }),
        ...props.style,
      } as React.CSSProperties}
      className={cx(classes.sidebar, classes[resizePosition], props.className)}
      ref={containerRef}
    >
      {resizePosition === 'left' && resizer}
      <div className={classes.content}>{children}</div>
      {resizePosition === 'right' && resizer}
    </div>
  );
}
