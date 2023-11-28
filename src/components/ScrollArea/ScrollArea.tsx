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

export function ScrollArea({ children, className, scrollRestore, ...props }: Props) {
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

type Props = BoxProps & {
  scrollRestore?: UseScrollRestoreProps;
};

const useStyles = createStyles(() => ({
  root: {
    height: '100%',
    width: '100%',
    flex: 1,
    // overflowY: 'auto',
    overflowX: 'hidden',
    willChange: 'transform',
    position: 'relative',
  },
}));
