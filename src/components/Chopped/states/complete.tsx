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

import { IconArrowLeft, IconCheck, IconPlus, IconX } from '@tabler/icons-react';
import { useState } from 'react';
import { useBuzzTransaction } from '~/components/Buzz/buzz.utils';
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
import { Embla } from '~/components/EmblaCarousel/EmblaCarousel';

export function Complete() {
  const submissions = useChoppedStore((state) =>
    Object.values(state.game!.rounds)
      .reverse()
      .flatMap((round) =>
        [...round.submissions].sort((a, b) => (b.judgeScore ?? 0) - (a.judgeScore ?? 0))
      )
  );

  // TODO.chopped - carousel auto play

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
      <Embla className="w-full" withIndicators>
        <Embla.Viewport>
          <Embla.Container className="flex">
            {submissions.map((submission, index) => (
              <Embla.Slide key={submission.id} index={index} className="flex-[0_0_100%]">
                <div className="flex justify-center">
                  <ChoppedUserSubmission submission={submission} />
                </div>
              </Embla.Slide>
            ))}
          </Embla.Container>
        </Embla.Viewport>
      </Embla>
    </ChoppedLayout>
  );
}
