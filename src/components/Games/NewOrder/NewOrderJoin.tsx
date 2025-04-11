import { Button, ThemeIcon } from '@mantine/core';
import { IconShieldStar } from '@tabler/icons-react';
import { useJoinKnightsNewOrder } from '~/components/Games/KnightsNewOrder.utils';

export function NewOrderJoin() {
  const { join } = useJoinKnightsNewOrder();

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
        <Button color="orange.5" size="lg" onClick={() => join()} fullWidth>
          Join Game
        </Button>
        <Button className="text-orange-5" variant="white" size="lg" fullWidth>
          Learn More
        </Button>
      </div>
    </div>
  );
}
