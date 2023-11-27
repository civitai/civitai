import { Box, BoxProps, createStyles } from '@mantine/core';
import { useMergedRef } from '@mantine/hooks';
import { RefObject, createContext, forwardRef, useContext, useRef } from 'react';
import { useResizeObserver } from '~/hooks/useResizeObserver';
import { useDebouncer } from '~/utils/debouncer';
import { EventEmitter } from '~/utils/eventEmitter';

type EmitterDict = { resize: ResizeObserverEntry };

type NodeState = {
  nodeRef: RefObject<HTMLDivElement>;
  emitterRef: RefObject<EventEmitter<EmitterDict>>;
};

const NodeContext = createContext<NodeState | null>(null);
export const useNodeContext = () => {
  const context = useContext(NodeContext);
  if (!context) throw 'missing NodeProvider';
  return context;
};

export const NodeProvider = forwardRef<HTMLDivElement, BoxProps & { containerName?: string }>(
  ({ children, containerName, ...props }, ref) => {
    const emitterRef = useRef(new EventEmitter<EmitterDict>());
    const debouncer = useDebouncer(300);
    const innerRef = useResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) debouncer(() => emitterRef.current.emit('resize', entry));
    });
    const mergedRef = useMergedRef(innerRef, ref);
    const { classes, cx } = useStyles();

    return (
      <NodeContext.Provider value={{ nodeRef: innerRef, emitterRef }}>
        <Box
          ref={mergedRef}
          {...props}
          className={cx(classes.root, props.className)}
          style={{ containerName, ...props.style }}
        >
          {children}
        </Box>
      </NodeContext.Provider>
    );
  }
);

NodeProvider.displayName = 'NodeProvider';

const useStyles = createStyles(() => ({
  root: {
    containerType: 'inline-size',
  },
}));
