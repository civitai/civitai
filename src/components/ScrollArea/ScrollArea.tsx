import { Box, BoxProps, createStyles } from '@mantine/core';
import { createContext, useContext } from 'react';
import { UseScrollRestoreProps, useScrollRestore } from '~/hooks/useScrollRestore';

const ScrollAreaContext = createContext<HTMLDivElement | null>(null);
export const useScrollAreaContext = () => useContext(ScrollAreaContext);

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
