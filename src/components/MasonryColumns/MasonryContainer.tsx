import type { BoxProps, ContainerProps } from '@mantine/core';
import { Box } from '@mantine/core';
import React, { CSSProperties } from 'react';
import type { MasonryContextState } from '~/components/MasonryColumns/MasonryProvider';
import { MasonryProvider, useMasonryContext } from '~/components/MasonryColumns/MasonryProvider';
import styles from './MasonryContainer.module.scss';
import clsx from 'clsx';

type MasonryContainerProps = Omit<BoxProps, 'children'> & {
  children: React.ReactNode | ((state: MasonryContextState) => React.ReactNode);
};

export function MasonryContainer({ children, ...boxProps }: MasonryContainerProps) {
  const masonryProviderState = useMasonryContext();
  const { columnWidth, columnGap, maxColumnCount, columnCount, combinedWidth } =
    masonryProviderState;

  const state = {
    ...masonryProviderState,
  };

  return (
    <MasonryProvider
      px="md"
      {...boxProps}
      className={clsx('@container', boxProps.className)}
      maxColumnCount={columnCount}
    >
      <div
        style={{
          width: columnCount > 1 && combinedWidth ? combinedWidth : undefined,
        }}
        className={styles.queries}
      >
        {typeof children === 'function' ? children(state) : children}
      </div>
    </MasonryProvider>
  );
}
