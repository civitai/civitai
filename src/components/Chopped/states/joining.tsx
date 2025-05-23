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
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { getRandom, shuffle } from '~/utils/array-helpers';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import { useChoppedServer } from '~/components/Chopped/chopped.connection';
import { ChoppedLayout } from '~/components/Chopped/chopped.components';

export function Joining() {
  const [joinState, setJoinState] = useState<JoinGame>({
    code: '',
    name: '',
  });

  const server = useChoppedServer();
  const joinGame = async () => {
    server.join(joinState);
  };

  // Progression
  const canJoin = joinState.code.length > 0 && joinState.name.length > 0;

  return (
    <ChoppedLayout title="Join Game">
      <Stack>
        <Text size="lg" fw={500} mb={-12}>
          Game Code
        </Text>
        <TextInput
          value={joinState.code}
          size="md"
          maxLength={6}
          onChange={(event) => {
            setJoinState((state) => ({ ...state, code: event.target.value }));
          }}
          placeholder="ABC123"
        />

        <Text size="lg" fw={500} mb={-12}>
          {`What's your name?`}
        </Text>
        <TextInput
          value={joinState.name}
          size="md"
          maxLength={12}
          onChange={(event) => {
            setJoinState((state) => ({ ...state, name: event.target.value }));
          }}
          placeholder="Your name"
        />

        <Button size="lg" disabled={!canJoin} mt="md" onClick={joinGame}>
          Join Game
        </Button>
      </Stack>
    </ChoppedLayout>
  );
}
