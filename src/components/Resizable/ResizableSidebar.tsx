import React from 'react';
import { useResize } from './useResize';
import { createStyles } from '@mantine/core';

export type ResizableSidebarProps = {
  resizePosition: 'left' | 'right'; // maybe rename to 'position'?
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
};

export function ResizableSidebar({
  children,
  resizePosition,
  minWidth,
  maxWidth,
  defaultWidth,
  ...props
}: ResizableSidebarProps) {
  const { classes, cx } = useStyles({ resizeFrom: resizePosition });
  const { containerRef, resizerRef, contentRef } = useResize({
    resizePosition,
    minWidth,
    maxWidth,
    defaultWidth,
  });

  const resizer = <div className={classes.resizer} ref={resizerRef} />;

  return (
    <div
      {...props}
      style={{ width: defaultWidth, ...props.style }}
      className={cx(classes.sidebar, props.className)}
      ref={containerRef}
    >
      {resizePosition === 'left' && resizer}
      <div className={classes.content} ref={contentRef}>
        {children}
      </div>
      {resizePosition === 'right' && resizer}
    </div>
  );
}

const useStyles = createStyles((theme, { resizeFrom }: { resizeFrom: 'left' | 'right' }) => {
  const borderOrientation = resizeFrom === 'left' ? 'borderLeft' : 'borderRight';
  return {
    sidebar: {
      display: 'flex',
      height: '100%',
      alignItems: 'stretch',
    },
    resizer: {
      flexGrow: 0,
      flexShrink: 0,
      flexBasis: 6,
      resize: 'horizontal',
      cursor: 'col-resize',
      padding: '0px 1px',
      width: 3,
      [borderOrientation]:
        theme.colorScheme === 'dark'
          ? `1px solid ${theme.colors.dark[5]}`
          : `1px solid ${theme.colors.gray[2]}`,

      '&:hover': {
        width: 3,
        background: '#c1c3c5b4', // TODO
      },
    },
    content: {
      flex: 1,
    },
  };
});
