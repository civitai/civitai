import React from 'react';
import { Container, Styles } from '@mantine/core';

type Props = { children: React.ReactNode; styles?: Styles<never, Record<string, any>> };

const HomeBlockWrapper = ({ children, styles }: Props) => {
  return (
    <Container fluid styles={styles}>
      <Container size="xl">{children}</Container>
    </Container>
  );
};

export default HomeBlockWrapper;
