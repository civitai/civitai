/* eslint-disable @next/next/no-img-element */
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
import { useState } from 'react';
import { useBuzzTransaction } from '~/components/Buzz/buzz.utils';
import { GameState, GlobalState, NewGame } from '~/components/Chopped/chopped.shared-types';
import { ComputeCost, defaultGameState, useChoppedStore } from '~/components/Chopped/chopped.utils';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { getRandom, shuffle } from '~/utils/array-helpers';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import { ChoppedLayout } from '~/components/Chopped/chopped.components';
import { useChoppedServer } from '~/components/Chopped/chopped.connection';

export function Landing() {
  const setGameState = useChoppedStore((state) => state.setGame);
  const startNewGame = () => {
    setGameState({ ...defaultGameState, status: 'setup' });
  };
  const joinGame = () => {
    setGameState({ ...defaultGameState, status: 'joining' });
  };

  return (
    <ChoppedLayout>
      <Stack>
        <img src="/images/civitai_chopped_dark.png" alt="civitai chopped logo" />
        {/* <Title align="center">Civitai Chopped</Title> */}
        <Button onClick={startNewGame}>New Game</Button>
        <Button onClick={joinGame}>Join Game</Button>
      </Stack>
    </ChoppedLayout>
  );
}
