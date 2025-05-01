import { Button, ThemeIcon } from '@mantine/core';
import { IconShieldStar } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { useJoinKnightsNewOrder } from '~/components/Games/KnightsNewOrder.utils';
import { NewOrderRulesModal } from '~/components/Games/NewOrder/NewOrderRulesModal';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';

export function NewOrderJoin() {
  const { join, isLoading } = useJoinKnightsNewOrder();
  const [opened, setOpened] = useState(false);

  const joinButton = useMemo(
    () => (
      <LoginRedirect reason="knights-new-order">
        <Button color="orange.5" size="lg" onClick={() => join()} loading={isLoading} fullWidth>
          Join Game
        </Button>
      </LoginRedirect>
    ),
    [join, isLoading]
  );

  return (
    <div className="flex size-full items-center justify-center p-4">
      <div className="mx-auto flex w-full max-w-[448px] flex-col items-center gap-4 text-center">
        <ThemeIcon
          className="rounded-full border border-orange-5"
          size={128}
          color="orange"
          variant="light"
        >
          <IconShieldStar className="size-16" />
        </ThemeIcon>
        <h1 className="text-4xl font-bold tracking-tight text-orange-5 md:text-5xl">
          Knights of New Order
        </h1>
        <p>Forge your destiny in a realm of honor and glory</p>
        {joinButton}
        <Button
          className="text-orange-5"
          variant="white"
          size="lg"
          onClick={() => setOpened(true)}
          fullWidth
        >
          Learn More
        </Button>
      </div>
      <NewOrderRulesModal opened={opened} onClose={() => setOpened(false)} footer={joinButton} />
    </div>
  );
}
