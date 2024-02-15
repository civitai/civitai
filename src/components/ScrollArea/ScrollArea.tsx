import { Box, BoxProps, ThemeIcon, createStyles, useMantineTheme } from '@mantine/core';
import { useMergedRef } from '@mantine/hooks';
import { IconRefresh } from '@tabler/icons-react';

import React, { RefObject, createContext, forwardRef, useContext, useEffect, useRef } from 'react';
import { useIsMobile } from '~/hooks/useIsMobile';
import { UseScrollRestoreProps, useScrollRestore } from '~/hooks/useScrollRestore';

const ScrollAreaContext = createContext<{
  ref: RefObject<HTMLDivElement> | null;
} | null>(null);
export const useScrollAreaRef = (args?: { onScroll?: () => void }) => {
  const onScrollRef = useRef<(() => void) | null>(null);
  const context = useContext(ScrollAreaContext);
  const { ref } = context ?? {};
  onScrollRef.current = args?.onScroll ?? null;

  useEffect(() => {
    const elem = ref?.current;
    const onScroll = onScrollRef.current;
    if (!onScroll || !elem) return;
    elem?.addEventListener('scroll', onScroll);
    return () => {
      elem?.removeEventListener('scroll', onScroll);
    };
  }, []); // eslint-disable-line

  return ref;
};

export const ScrollArea = forwardRef<HTMLElement, ScrollAreaProps>(
  ({ children, className, scrollRestore, ...props }, ref) => {
    const { classes, cx } = useStyles();
    const scrollRef = useScrollRestore<HTMLDivElement>(scrollRestore);
    const mergedRef = useMergedRef(ref, scrollRef);

    const dragHeight = 220;
    const loaderRef = useRef<HTMLDivElement>(null);
    const startPointRef = useRef<number | null>(null);
    const pullChangeRef = useRef(0);
    const theme = useMantineTheme();
    // Hardset breakpoint to 1024px cause mantine breakpoints are huge
    const mobile = useIsMobile({ breakpoint: 'md' });

    useEffect(() => {
      const node = scrollRef.current;
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

      node.addEventListener('touchstart', pullStart);
      node.addEventListener('touchmove', pull);
      node.addEventListener('touchend', endPull);
      return () => {
        node.removeEventListener('touchstart', pullStart);
        node.removeEventListener('touchmove', pull);
        node.removeEventListener('touchend', endPull);
      };
    }, [mobile]);

    return (
      <ScrollAreaContext.Provider value={{ ref: scrollRef }}>
        <Box
          ref={mergedRef as any}
          className={cx(classes.root, className)}
          pt="md"
          pb="md"
          {...props}
        >
          {mobile && (
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
          )}
          {children}
        </Box>
      </ScrollAreaContext.Provider>
    );
  }
);

ScrollArea.displayName = 'ScrollArea';

// ScrollArea.displayName = 'ScrollArea';

export type ScrollAreaProps = BoxProps & {
  scrollRestore?: UseScrollRestoreProps;
};

const useStyles = createStyles(() => ({
  root: {
    height: '100%',
    width: '100%',
    flex: 1,
    overflowX: 'hidden',
    willChange: 'transform',
    position: 'relative',
    scrollbarWidth: 'thin',
  },
}));
