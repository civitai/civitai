import { Container } from '@mantine/core';
import { useInterval } from '@mantine/hooks';
import { useState } from 'react';
import { Countdown } from '~/components/Countdown/Countdown';

const date = new Date();
const offset = new Date(date.getTime() + 10 * 60000);
export default function Test() {
  const [state, setState] = useState(0);

  useInterval(() => setState((state) => state + 1), 1000);

  return (
    <Container size="xs">
      <Countdown endTime={offset} format="short"></Countdown>
    </Container>
  );
}
