import { Box, BoxProps, createStyles } from '@mantine/core';
import { RefObject, createContext, useContext, useEffect, useRef } from 'react';
import { UseScrollRestoreProps, useScrollRestore } from '~/hooks/useScrollRestore';

const ScrollAreaContext = createContext<{
  ref: RefObject<HTMLDivElement> | null;
  restore: () => void;
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

export const useTriggerScrollRestore = ({ condition }: { condition?: boolean }) => {
  const context = useContext(ScrollAreaContext);
  const { restore } = context ?? {};
  const restoredRef = useRef(false);

  useEffect(() => {
    if (condition === undefined || condition) {
      restore?.();
      restoredRef.current = true;
    }
  }, [condition, restore]);
};

export function ScrollArea({ children, className, scrollRestore, ...props }: ScrollAreaProps) {
  const { classes, cx } = useStyles();
  const { ref, restore } = useScrollRestore<HTMLDivElement>(scrollRestore);
  return (
    <ScrollAreaContext.Provider value={{ ref, restore }}>
      <Box ref={ref} className={cx(classes.root, className)} {...props}>
        {children}
      </Box>
    </ScrollAreaContext.Provider>
  );
}

ScrollArea.displayName = 'ScrollArea';

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
    // '&::-webkit-scrollbar': {
    //   width: '10px',
    //   height: '100%',
    // },
    // '&::-webkit-scrollbar-track': {
    //   background: '#f1f1f1',
    // },
    // '&::-webkit-scrollbar-thumb': {
    //   background: '#888',
    // },
    // '&::-webkit-scrollbar-thumb:hover': {
    //   background: '#555',
    // },
  },
}));
