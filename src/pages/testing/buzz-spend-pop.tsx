import { Button, Code, Group, Paper, Stack, Text, Title } from '@mantine/core';
import { IconMenu2 } from '@tabler/icons-react';
import { useRef } from 'react';
import { UserBuzz } from '~/components/User/UserBuzz';
import { BuzzTypes } from '~/shared/constants/buzz.constants';
import { recordBuzzUpdate, useBuzzDeltaStore } from '~/store/buzz-delta.store';
import { trpc } from '~/utils/trpc';

const START_BALANCE = 48210;
const START_YELLOW = 20000;
const ACCOUNT_TYPES = ['blue', 'yellow'] as const;

function randomSpend(max: number) {
  return -(5 + Math.floor(Math.random() * max));
}

/** Feeds `recordBuzzUpdate` and mirrors the cache update in `useBuzzSignalUpdate`, so the pop-out can be exercised without a live signal. */
export default function BuzzSpendPopTest() {
  const queryUtils = trpc.useUtils();
  const groups = useBuzzDeltaStore((state) => state.groups);
  const settled = useBuzzDeltaStore((state) => state.settled);
  const seeded = useRef(false);

  if (!seeded.current) {
    seeded.current = true;
    queryUtils.buzz.getBuzzAccount.setData(undefined, {
      blue: START_BALANCE,
      yellow: START_YELLOW,
      green: 0,
      red: 0,
    });
  }

  const apply = (delta: number) => {
    queryUtils.buzz.getBuzzAccount.setData(undefined, (old) =>
      old ? { ...old, blue: Math.max(0, old.blue + delta) } : old
    );
    recordBuzzUpdate({ accountType: BuzzTypes.toApiType('blue'), delta });
  };

  const burst = (count: number, spacingMs: number) => {
    for (let i = 0; i < count; i++) setTimeout(() => apply(randomSpend(300)), i * spacingMs);
  };

  const reset = () => {
    useBuzzDeltaStore.getState().reset();
    queryUtils.buzz.getBuzzAccount.setData(undefined, {
      blue: START_BALANCE,
      yellow: START_YELLOW,
      green: 0,
      red: 0,
    });
  };

  return (
    <Stack p="md" gap="md" maw={900} mx="auto">
      <Title>Buzz spend pop-out</Title>
      <Text size="sm" c="dimmed">
        Each button below takes the path of a <Code>BuzzUpdate</Code> signal. Catch-up lands all its
        spends in the same tick, like a tab that was in the background.
      </Text>

      <Group gap="xs">
        <Button onClick={() => apply(randomSpend(400))}>Spend one</Button>
        <Button variant="default" onClick={() => apply(-12500)}>
          Large 12.5K
        </Button>
        <Button variant="default" onClick={() => burst(20, 100)}>
          Burst x20
        </Button>
        <Button variant="default" onClick={() => burst(14, 0)}>
          Catch-up x14
        </Button>
        <Button variant="default" onClick={() => apply(250)}>
          Credit +250
        </Button>
        <Button variant="subtle" color="gray" onClick={reset}>
          Reset
        </Button>
      </Group>

      <Text size="xs" c="dimmed">
        Desktop header
      </Text>
      <Paper withBorder h={60} px="md" className="flex items-center justify-end">
        <UserBuzz animated withDeltaPop pr="sm" accountTypes={[...ACCOUNT_TYPES]} />
      </Paper>

      <Text size="xs" c="dimmed">
        Phone header (counter beside the burger)
      </Text>
      <Paper withBorder h={60} px="xs" maw={390} className="flex items-center justify-end">
        <UserBuzz animated withDeltaPop pr="sm" accountTypes={[...ACCOUNT_TYPES]} />
        <IconMenu2 size={24} />
      </Paper>

      <Text size="xs" c="dimmed">
        Store (open groups and the last settled one)
      </Text>
      <Code block>{JSON.stringify({ groups, settled }, null, 2)}</Code>
    </Stack>
  );
}
