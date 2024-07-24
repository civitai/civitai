import React, { RefObject, createContext, useCallback, useContext, useEffect } from 'react';
import { create } from 'zustand';
import { useResizeObserver } from '~/hooks/useResizeObserver';

type ContainerState = {
  nodeRef: RefObject<HTMLDivElement>;
  containerName: string;
};

const ContainerContext = createContext<ContainerState | null>(null);
export const useContainerContext = () => {
  const context = useContext(ContainerContext);
  if (!context) throw 'missing ContainerProvider';
  return context;
};

type ContainerProviderProps = React.HTMLProps<HTMLDivElement> & {
  containerName: string;
};

export const ContainerProvider = ({
  children,
  containerName,
  className,
  ...props
}: ContainerProviderProps) => {
  const innerRef = useResizeObserver<HTMLDivElement>((entry) => {
    useContainerProviderStore.setState(() => ({ [containerName]: entry.borderBoxSize[0] }));
  });

  useEffect(() => {
    const container = innerRef.current;
    if (container) {
      useContainerProviderStore.setState(() => ({
        [containerName]: { inlineSize: container.clientWidth, blockSize: container.clientHeight },
      }));
    }
  }, []);

  return (
    <ContainerContext.Provider value={{ nodeRef: innerRef, containerName }}>
      <div
        ref={innerRef}
        {...props}
        className={`relative flex h-full flex-col @container ${className ? className : ''}`}
      >
        {children}
      </div>
    </ContainerContext.Provider>
  );
};

export const useContainerProviderStore = create<Record<string, ResizeObserverSize>>(() => ({}));

export function useContainerWidth(containerNameOverride?: string) {
  const { containerName } = useContainerContext();
  const _containerName = containerNameOverride ?? containerName;
  return useContainerProviderStore(
    useCallback((state) => state[_containerName]?.inlineSize, [_containerName])
  );
}
