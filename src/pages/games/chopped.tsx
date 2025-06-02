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
import { IconCheck, IconPlus, IconX } from '@tabler/icons-react';
import { useState, ReactNode } from 'react';
import { useBuzzTransaction } from '~/components/Buzz/buzz.utils';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import type { GameState } from '~/components/Chopped/chopped.shared-types';
import { GlobalState, NewGame } from '~/components/Chopped/chopped.shared-types';
import { ComputeCost, useChoppedStore } from '~/components/Chopped/chopped.utils';
import { Complete } from '~/components/Chopped/states/complete';
import { Joining } from '~/components/Chopped/states/joining';
import { Landing } from '~/components/Chopped/states/landing';
import { Playing } from '~/components/Chopped/states/playing';
import { Setup } from '~/components/Chopped/states/setup';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { getRandom, shuffle } from '~/utils/array-helpers';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import { ChoppedLayout, ChoppedErrorBoundary } from '~/components/Chopped/chopped.components';

export default function Chopped() {
  const gameStatus = useChoppedStore((state) => state.game?.status ?? 'landing');
  const StateComponent = gameStates[gameStatus];
  return (
    <ChoppedErrorBoundary>
      <StateComponent />
    </ChoppedErrorBoundary>
  );
}

const gameStates: Record<GameState['status'] | 'landing', React.FC> = {
  landing: Landing,
  setup: Setup,
  joining: Joining,
  playing: Playing,
  complete: Complete,
};

// export default createPage(Chopped, { withScrollArea: false, withFooter: false })
// export default createPage(Chopped, { layout: ({ children }) => <main className="size-full">{children}</main> })
