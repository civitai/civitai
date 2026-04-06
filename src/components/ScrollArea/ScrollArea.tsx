import type { BoxProps } from '@mantine/core';
import { Box, ThemeIcon, useMantineTheme } from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';

import React, { useEffect, useRef, useState } from 'react';
import { IntersectionObserverProvider } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import { ScrollAreaContext, useScrollAreaRef } from '~/components/ScrollArea/ScrollAreaContext';
import { isMobileDevice } from '~/hooks/useIsMobile';
import type { UseScrollRestoreProps } from '~/hooks/useScrollRestore';
import { useScrollRestore } from '~/hooks/useScrollRestore';
import clsx from 'clsx';

export function ScrollArea({
  children,
  className,
  scrollRestore,
  intersectionObserverOptions,
  ...props
}: ScrollAreaProps & { children: React.ReactNode }) {
  const { ref: scrollRef, key } = useScrollRestore<HTMLDivElement>(scrollRestore);
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    setIsMobile(isMobileDevice());
  }, []);

  return (
    <ScrollAreaContext.Provider value={{ ref: scrollRef }}>
      <IntersectionObserverProvider id={props.id ?? key} options={intersectionObserverOptions}>
        <Box
          ref={scrollRef}
          className={clsx('scroll-area flex-1 @container ', className)}
          {...props}
        >
          {isMobile && <DragLoader />}
          {children}
        </Box>
      </IntersectionObserverProvider>
    </ScrollAreaContext.Provider>
  );
}
// [&_*]:!pointer-events-none

// ScrollArea.displayName = 'ScrollArea';

export type ScrollAreaProps = BoxProps & {
  scrollRestore?: UseScrollRestoreProps;
  id?: string;
  intersectionObserverOptions?: IntersectionObserverInit;
};

function DragLoader() {
  const scrollRef = useScrollAreaRef();
  const dragHeight = 220;
  const loaderRef = useRef<HTMLDivElement>(null);
  const startPointRef = useRef<number | null>(null);
  const pullChangeRef = useRef(0);
  const theme = useMantineTheme();

  useEffect(() => {
    const node = scrollRef?.current;
    const loader = loaderRef.current;
    if (!node || !loader) return;

    const refresh = () => {
      setTimeout(() => {
        window.location.reload();
      }, 1000);
    };

    const pullStart = (e: TouchEvent) => {
      const { screenY } = e.targetTouches[0];
      if (node.scrollTop === 0) {
        startPointRef.current = screenY;
      }
    };

    const reset = () => {
      loader.style.transition = '.2s ease-in-out';
      loader.style.top = `${-loader.clientHeight}px`;
      loader.style.opacity = '0';
      pullChangeRef.current = 0;
      startPointRef.current = null;
    };

    const pull = (e: TouchEvent) => {
      if (!startPointRef.current) return;
      if (node.scrollTop > 0) {
        reset();
        return;
      }
      const startPoint = startPointRef.current;
      if (!startPoint) return;
      /**
       * get the current user touch event data
       */
      const touch = e.targetTouches[0];
      /**
       * get the touch position on the screen's Y axis
       */
      const { screenY } = touch;
      /**
       * The length of the pull
       *
       * if the start touch position is lesser than the current touch position, calculate the difference, which gives the `pullLength`
       *
       * This tells us how much the user has pulled
       */
      const pullLength = startPoint < screenY ? Math.abs(screenY - startPoint) : 0;
      pullChangeRef.current = pullLength;

      const pullPosition = pullLength > 220 ? 220 : pullLength;
      const decimalPercentage = pullPosition / dragHeight;
      const opacity = 1 * decimalPercentage;

      loader.style.removeProperty('transition');
      loader.style.opacity = `${opacity > 1 ? 1 : opacity}`;
      loader.style.top = `${
        -loader.clientHeight + pullPosition / 2 + loader.clientHeight * decimalPercentage
      }px`;
    };

    const endPull = () => {
      loader.style.transition = '.2s ease-in-out';
      if (pullChangeRef.current > dragHeight) {
        loader.style.top = `${theme.spacing.md}px`;
        loader.style.animation = 'overscroll-spin 1s infinite linear';
        refresh();
      } else {
        reset();
      }
    };

    node.addEventListener('touchstart', pullStart, { passive: true });
    node.addEventListener('touchmove', pull, { passive: true });
    node.addEventListener('touchend', endPull, { passive: true });
    return () => {
      node.removeEventListener('touchstart', pullStart);
      node.removeEventListener('touchmove', pull);
      node.removeEventListener('touchend', endPull);
    };
  }, []);

  return (
    <ThemeIcon
      ref={loaderRef}
      radius="xl"
      size="xl"
      style={{
        position: 'absolute',
        left: '50%',
        zIndex: 10,
        opacity: 0,
        transform: 'translateX(-50%)',
      }}
    >
      <IconRefresh />
    </ThemeIcon>
  );
}
