import { Box, BoxProps, createPolymorphicComponent, createStyles } from '@mantine/core';
import { useMergedRef } from '@mantine/hooks';
import { RefObject, createContext, forwardRef, useContext, useRef } from 'react';
import { create } from 'zustand';
import { useResizeObserver } from '~/hooks/useResizeObserver';
import { EventEmitter } from '~/utils/eventEmitter';

type EmitterDict = { resize: ResizeObserverEntry };

type ContainerState = {
  nodeRef: RefObject<HTMLDivElement>;
  emitterRef: RefObject<EventEmitter<EmitterDict>>;
  containerName: string;
};

const ContainerContext = createContext<ContainerState | null>(null);
export const useContainerContext = () => {
  const context = useContext(ContainerContext);
  if (!context) throw 'missing NodeProvider';
  return context;
};

type ContainerProviderProps = BoxProps & { containerName: string };

const _ContainerProvider = forwardRef<HTMLDivElement, ContainerProviderProps>(
  ({ children, containerName, ...props }, ref) => {
    const emitterRef = useRef(new EventEmitter<EmitterDict>());
    const innerRef = useResizeObserver((entries) => {
      const entry = entries[0];
      useContainerProviderStore.setState(() => ({ [containerName]: entry.contentBoxSize[0] }));
    });
    const mergedRef = useMergedRef(innerRef, ref);
    const { classes, cx } = useStyles();

    return (
      <ContainerContext.Provider value={{ nodeRef: innerRef, emitterRef, containerName }}>
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
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    flex: 1,
    overflow: 'hidden',
  },
}));

export const useContainerProviderStore = create<Record<string, ResizeObserverSize>>(() => ({}));
