import React from 'react';
import { Container, ContainerProps } from '@mantine/core';

export const HomeBlockWrapper = ({
  children,
  innerContainerProps,
  ...props
}: ContainerProps & { innerContainerProps: ContainerProps }) => {
  return (
    <Container fluid {...props}>
      <Container size="xl" {...innerContainerProps}>
        {children}
      </Container>
    </Container>
  );
};
