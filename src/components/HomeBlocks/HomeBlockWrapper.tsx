import React from 'react';
import { Container, ContainerProps } from '@mantine/core';

export const HomeBlockWrapper = ({ children, ...props }: ContainerProps) => {
  return (
    <Container fluid {...props}>
      <Container size="xl">{children}</Container>
    </Container>
  );
};
