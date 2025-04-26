import { Box, BoxProps } from '@mantine/core';
import React, { forwardRef } from 'react';
import {
  MasonryContextState,
  MasonryProvider,
  useMasonryContext,
} from '~/components/MasonryColumns/MasonryProvider';
import styles from './MasonryContainer.module.scss';
import clsx from 'clsx';

type MasonryContainerProps = Omit<BoxProps, 'children'> & {
  children: React.ReactNode | ((state: MasonryContextState) => React.ReactNode);
};

export const MasonryContainer = forwardRef<HTMLDivElement, MasonryContainerProps>((props, ref) => {
  const { children, className, ...others } = props;
  const masonryContext = useMasonryContext();

  return (
    <MasonryProvider>
      <Box className={`${styles.container} ${className}`} {...others} ref={ref}>
        {typeof children === 'function' ? children(masonryContext) : children}
      </Box>
    </MasonryProvider>
  );
});

MasonryContainer.displayName = 'MasonryContainer';
