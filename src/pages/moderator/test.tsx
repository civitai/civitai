import { Container, Stack } from '@mantine/core';
import { useInterval } from '@mantine/hooks';
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { Countdown } from '~/components/Countdown/Countdown';

const useStore = create(() => ({ foo: true, bar: true, test: true, count: 0 }));

const date = new Date();
const offset = new Date(date.getTime() + 10 * 60000);
export default function Test() {
  const [state, setState] = useState(0);

  useInterval(() => setState((state) => state + 1), 1000);

  return (
    <Container size="xs">
      <Stack>
        <Countdown endTime={offset} format="short"></Countdown>
        <Foo />
        <Bar />
        <Derived />
      </Stack>
    </Container>
  );
}

const Foo = () => {
  const foo = useStore((state) => state.foo);

  useEffect(() => {
    setTimeout(() => {
      useStore.setState((state) => ({ ...state, foo: false }));
    }, 2000);
  }, []);

  return <p>Foo: {`${foo}`}</p>;
};

const Bar = () => {
  const bar = useStore((state) => state.bar);

  useEffect(() => {
    setTimeout(() => {
      useStore.setState((state) => ({ ...state, bar: false }));
    }, 1000);

    setInterval(() => {
      useStore.setState((state) => ({ ...state, count: state.count + 1 }));
    }, 1000);
  }, []);

  return <p>Bar: {`${bar}`}</p>;
};

const Derived = () => {
  const derived = useStore(({ bar, test, count }) => {
    const num = count === 0 ? 1 : count <= 2 ? 2 : count <= 5 ? 3 : count <= 8 ? 4 : 5;
    return `Bar: ${bar}, Test: ${test}, Count: ${num}`;
  });

  return <p>{derived}</p>;
};
