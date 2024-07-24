import React from 'react';
import { useResize } from './useResize';
import { createStyles } from '@mantine/core';
import { IsClient } from '~/components/IsClient/IsClient';

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
  const { classes, cx } = useStyles({ resizeFrom: resizePosition });
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
      style={{ ...props.style }}
      className={cx(classes.sidebar, props.className)}
      ref={containerRef}
    >
      {resizePosition === 'left' && resizer}
      <div className={classes.content}>{children}</div>
      {resizePosition === 'right' && resizer}
    </div>
  );
}

const useStyles = createStyles((theme, { resizeFrom }: { resizeFrom: 'left' | 'right' }) => {
  const borderOrientation = resizeFrom === 'left' ? 'borderLeft' : 'borderRight';
  return {
    sidebar: {
      overflowX: 'visible',
      position: 'relative',
      display: 'flex',
      height: '100%',
      alignItems: 'stretch',
    },
    resizer: {
      cursor: 'ew-resize',
      position: 'absolute',
      top: 0,
      height: '100%',
      [resizeFrom]: -2,
      width: 5,
      zIndex: 100,
      // opacity: 0.2,

      '&:hover, &:active': {
        // background: '#007fd4',
        background: theme.colors[theme.primaryColor][theme.colorScheme === 'dark' ? 8 : 6],
      },
    },
    content: {
      containerName: 'sidebar',
      containerType: 'inline-size',
      flex: 1,
      [borderOrientation]:
        theme.colorScheme === 'dark'
          ? `1px solid ${theme.colors.dark[5]}`
          : `1px solid ${theme.colors.gray[2]}`,
    },
  };
});

// export const ResizableSidebar = (props: ResizableSidebarProps) => {
//   return (
//     <IsClient>
//       <ResizableSidebarInner {...props} />
//     </IsClient>
//   );
// };
