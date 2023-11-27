import { Box, BoxProps, createPolymorphicComponent, createStyles } from '@mantine/core';
import { useMergedRef } from '@mantine/hooks';
import { RefObject, createContext, forwardRef, useContext, useRef } from 'react';
import { useResizeObserver } from '~/hooks/useResizeObserver';
import { useDebouncer } from '~/utils/debouncer';
import { EventEmitter } from '~/utils/eventEmitter';

type EmitterDict = { resize: ResizeObserverEntry };

type ContainerState = {
  nodeRef: RefObject<HTMLDivElement>;
  emitterRef: RefObject<EventEmitter<EmitterDict>>;
};

const ContainerContext = createContext<ContainerState | null>(null);
export const useNodeContext = () => {
  const context = useContext(ContainerContext);
  if (!context) throw 'missing NodeProvider';
  return context;
};

type ContainerProviderProps = BoxProps & { containerName?: string };

const _ContainerProvider = forwardRef<HTMLDivElement, ContainerProviderProps>(
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
      <ContainerContext.Provider value={{ nodeRef: innerRef, emitterRef }}>
        <Box
          ref={mergedRef}
          {...props}
          className={cx(classes.root, props.className)}
          style={{ containerName, ...props.style }}
        >
          {children}
        </Box>
      </ContainerContext.Provider>
    );
  }
);

_ContainerProvider.displayName = 'ContainerProvider';

export const ContainerProvider = createPolymorphicComponent<'div', ContainerProviderProps>(
  _ContainerProvider
);

const useStyles = createStyles(() => ({
  root: {
    containerType: 'inline-size',
  },
}));
