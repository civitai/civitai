import { Box, BoxProps, createStyles } from '@mantine/core';
import { createContext, useContext, useEffect } from 'react';
import { UseScrollRestoreProps, useScrollRestore } from '~/hooks/useScrollRestore';

const ScrollAreaContext = createContext<HTMLDivElement | null>(null);
export const useScrollAreaNode = (args?: { onScroll?: () => void }) => {
  const { onScroll } = args ?? {};
  const node = useContext(ScrollAreaContext);

  useEffect(() => {
    if (!onScroll) return;
    node?.addEventListener('scroll', onScroll);
    return () => {
      node?.removeEventListener('scroll', onScroll);
    };
  }, []);

  return node;
};

export function ScrollArea({ children, className, scrollRestore, ...props }: Props) {
  const { classes, cx } = useStyles();
  const { node, setRef } = useScrollRestore<HTMLDivElement>(scrollRestore);
  return (
    <ScrollAreaContext.Provider value={node}>
      <Box ref={setRef} className={cx(classes.root, className)} {...props}>
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
    overflowY: 'auto',
    willChange: 'transform',
  },
}));
