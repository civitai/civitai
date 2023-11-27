import { BoxProps, createStyles } from '@mantine/core';
import { RefObject, createContext, useContext, useEffect } from 'react';
import { NodeProvider } from '~/components/NodeProvider/NodeProvider';
import { UseScrollRestoreProps, useScrollRestore } from '~/hooks/useScrollRestore';

const ScrollAreaContext = createContext<RefObject<HTMLDivElement> | null>(null);
export const useScrollAreaNode = (args?: { onScroll?: () => void }) => {
  const { onScroll } = args ?? {};
  const node = useContext(ScrollAreaContext);

  useEffect(() => {
    const elem = node?.current;
    if (!onScroll || !elem) return;
    elem?.addEventListener('scroll', onScroll);
    return () => {
      elem?.removeEventListener('scroll', onScroll);
    };
  }, []);

  return node;
};

export function ScrollArea({ children, className, scrollRestore, ...props }: Props) {
  const { classes, cx } = useStyles();
  const ref = useScrollRestore<HTMLDivElement>(scrollRestore);
  return (
    <ScrollAreaContext.Provider value={ref}>
      <NodeProvider ref={ref} className={cx(classes.root, className)} {...props}>
        {children}
      </NodeProvider>
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
    position: 'relative',
  },
}));
