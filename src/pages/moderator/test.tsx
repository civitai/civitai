import { Container } from '@mantine/core';
import { useInterval } from '@mantine/hooks';
import { useState } from 'react';
import { Countdown } from '~/components/Countdown/Countdown';
import { Generate } from '~/components/ImageGeneration/Generate';

const date = new Date();
const offset = new Date(date.getTime() + 10000);
export default function Test() {
  const [state, setState] = useState(0);

  useInterval(() => setState((state) => state + 1), 1000);

  return (
    <Container size="xs">
      <Countdown endTime={offset}></Countdown>
      {/* <AssociateModels fromId={43331} type="Suggested" /> */}
      {/* <Generate /> */}
    </Container>
  );
}
