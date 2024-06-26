import {
  ActionIcon,
  Button,
  Card,
  Container,
  Group,
  Stack,
  Title,
  Text,
  Select,
  Alert,
  Input,
  TextInput,
  NumberInput,
} from '@mantine/core';
import { Carousel } from '@mantine/carousel';
import { IconArrowLeft, IconCheck, IconPlus, IconX } from '@tabler/icons-react';
import { useState } from 'react';
import { useBuzzTransaction } from '~/components/Buzz/buzz.utils';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import {
  GameState,
  GlobalState,
  JoinGame,
  NewGame,
} from '~/components/Chopped/chopped.shared-types';
import { ComputeCost, useChoppedStore } from '~/components/Chopped/chopped.utils';
import { ChoppedUserSubmission } from '~/components/Chopped/chopped.components';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { getRandom, shuffle } from '~/utils/array-helpers';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import { ChoppedLayout } from '~/components/Chopped/chopped.components';

export function Complete() {
  const submissions = useChoppedStore((state) =>
    state.game!.rounds.flatMap((round) =>
      round.submissions.sort((a, b) => (b.judgeScore ?? 0) - (a.judgeScore ?? 0))
    )
  );

  function handleClick() {
    // TODO.chopped - play again - update player state?
  }

  return (
    <ChoppedLayout
      title="Thanks for Playing!"
      canBack
      // footer={
      //   <div className="w-full flex">
      //     <Button className="flex-1" onClick={handleClick}>
      //       Play Again
      //     </Button>
      //   </div>
      // }
    >
      <Carousel className="w-full" withIndicators>
        {submissions.map((submission) => (
          <Carousel.Slide key={submission.id}>
            <div className="flex justify-center">
              <ChoppedUserSubmission submission={submission} />
            </div>
          </Carousel.Slide>
        ))}
      </Carousel>
    </ChoppedLayout>
  );
}
