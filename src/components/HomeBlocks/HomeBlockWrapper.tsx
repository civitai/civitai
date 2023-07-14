import React from 'react';
import { Container, ContainerProps } from '@mantine/core';

const HomeBlockWrapper = ({ children, ...props }: ContainerProps) => {
  return (
    <Container fluid {...props}>
      <Container size="xl">{children}</Container>
    </Container>
  );
};

export default HomeBlockWrapper;
