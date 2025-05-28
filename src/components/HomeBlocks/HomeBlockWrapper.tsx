import type { ContainerProps } from '@mantine/core';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import React from 'react';

export const HomeBlockWrapper = ({ children, ...props }: Props) => {
  return (
    <div>
      <MasonryContainer {...props}>{children}</MasonryContainer>
    </div>
  );
};

type Props = ContainerProps;
