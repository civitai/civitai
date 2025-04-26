import { Box, BoxProps } from '@mantine/core';
import React, { forwardRef } from 'react';
import styles from './Cards.module.scss';

export interface CardsProps extends BoxProps {
  aspectRatio?: number;
}

export const Cards = forwardRef<HTMLDivElement, CardsProps>((props, ref) => {
  const { aspectRatio = 1, className, ...others } = props;

  return (
    <Box
      className={`${styles.root} ${className}`}
      style={
        { '--image-position': aspectRatio < 1 ? 'top center' : 'center' } as React.CSSProperties
      }
      {...others}
      ref={ref}
    />
  );
});
