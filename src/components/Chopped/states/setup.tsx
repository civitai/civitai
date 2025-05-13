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
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { GameState, GlobalState, NewGame } from '~/components/Chopped/chopped.shared-types';
import { ComputeCost, useChoppedStore } from '~/components/Chopped/chopped.utils';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { getRandom, shuffle } from '~/utils/array-helpers';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import { useChoppedServer } from '~/components/Chopped/chopped.connection';
import { ChoppedLayout } from '~/components/Chopped/chopped.components';

export function Setup() {
  const global = useChoppedStore((state) => state.global);
  const [newGameState, setNewGameState] = useState<NewGame>({
    themeIds: shuffle(global.themes.map((theme) => theme.id)).slice(0, 3),
    judgeIds: global.judges.map((judge) => judge.id),
    includeAudio: false,
    name: 'Master Chef',
    maxPlayers: 4,
    viewOnly: false,
  });

  // Theme controls
  const themeOptions = global.themes.map((theme) => ({ value: theme.id, label: theme.name }));
  const setTheme = (themeId: string, i: number) => {
    setNewGameState((state) => {
      const newThemeIds = [...state.themeIds];
      newThemeIds[i] = themeId;
      return { ...state, themeIds: newThemeIds };
    });
  };
  const removeRound = (i: number) => {
    setNewGameState((state) => {
      const newThemeIds = [...state.themeIds];
      newThemeIds.splice(i, 1);
      return { ...state, themeIds: newThemeIds };
    });
  };
  const addRound = () => {
    setNewGameState((state) => {
      const randomThemeId = getRandom(global.themes).id;
      const newThemeIds = [...state.themeIds, randomThemeId];
      return { ...state, themeIds: newThemeIds };
    });
  };
  const canAddRounds = newGameState.themeIds.length < 5;

  // Judge controls
  const toggleJudge = (judgeId: string) => {
    setNewGameState((state) => {
      const newJudgeIds = state.judgeIds.includes(judgeId)
        ? state.judgeIds.filter((id) => id !== judgeId)
        : [...state.judgeIds, judgeId];
      return { ...state, judgeIds: newJudgeIds };
    });
  };

  // Progression
  const canStart =
    newGameState.themeIds.length > 0 &&
    newGameState.judgeIds.length > 0 &&
    (newGameState.viewOnly || newGameState.name.length > 0);
  const cost = ComputeCost(newGameState);

  // Charge
  const server = useChoppedServer();
  const { mutateAsync: startGame, isLoading } = trpc.games.chopped.start.useMutation({
    onSuccess: (data) => {
      console.log('Game created', data);
      newGameState.code = data.code;
      server.createGame(newGameState);
      setNewGameState((state) => ({ ...state, code: data.code }));
    },
  });

  return (
    <ChoppedLayout title="New Game" canBack>
      <Stack>
        <Group mb={-12}>
          <Text size="lg" weight={500}>
            Rounds
          </Text>
          <Button
            ml="auto"
            size="compact-xs"
            variant="light"
            onClick={addRound}
            disabled={!canAddRounds}
          >
            <Group gap={4}>
              <IconPlus size={14} strokeWidth={2.5} />
              Add
            </Group>
          </Button>
        </Group>
        <Card withBorder p={0} className="overflow-visible">
          {newGameState.themeIds.length === 0 && (
            <Card.Section>
              <Alert color="yellow" title="Add some rounds..." radius={0}>
                <Text>{`Ack! You need at least 1 round to start a game.`}</Text>
              </Alert>
            </Card.Section>
          )}
          {newGameState.themeIds.map((themeId, i) => {
            return (
              <Card.Section key={i} withBorder pr="xs">
                <Group gap={0}>
                  <Select
                    size="md"
                    data={themeOptions}
                    value={themeId}
                    onChange={(value) => {
                      setTheme(value!, i);
                    }}
                    radius={0}
                    styles={{
                      input: { border: 0 },
                    }}
                    className="flex-1"
                  />
                  <ActionIcon size="xs" onClick={() => removeRound(i)}>
                    <IconX strokeWidth={2.5} />
                  </ActionIcon>
                </Group>
              </Card.Section>
            );
          })}
        </Card>

        <Group mb={-12}>
          <Text size="lg" weight={500}>
            Judges
          </Text>
          <Button
            ml="auto"
            size="compact-xs"
            variant="light"
            pl={4}
            color={newGameState.includeAudio ? 'blue' : 'gray'}
            onClick={() =>
              setNewGameState((state) => ({ ...state, includeAudio: !state.includeAudio }))
            }
          >
            <Group gap={4}>
              {newGameState.includeAudio ? (
                <IconCheck size={14} strokeWidth={2.5} />
              ) : (
                <IconX size={14} strokeWidth={2.5} />
              )}
              Speech
            </Group>
          </Button>
        </Group>
        <Card withBorder className="overflow-visible">
          {newGameState.judgeIds.length === 0 && (
            <Card.Section>
              <Alert color="yellow" title="Select a judge..." radius={0}>
                <Text>{`You need at least 1 judge to assess the submissions of each round`}</Text>
              </Alert>
            </Card.Section>
          )}
          {global.judges.map((judge) => {
            const isSelected = newGameState.judgeIds.includes(judge.id);
            return (
              <Card.Section key={judge.id} withBorder px="xs" py="xs">
                <Group>
                  <EdgeMedia src={judge.avatar} width={48} />
                  <Stack gap={0}>
                    <Text weight={500}>{judge.name}</Text>
                    <Text size="xs" color="dimmed">
                      {judge.shortDescription}
                    </Text>
                  </Stack>
                  <ActionIcon
                    size="md"
                    variant="filled"
                    color={isSelected ? 'blue' : 'gray'}
                    onClick={() => toggleJudge(judge.id)}
                    radius="xl"
                    ml="auto"
                  >
                    {isSelected ? <IconCheck strokeWidth={2.5} /> : <IconX strokeWidth={2.5} />}
                  </ActionIcon>
                </Group>
              </Card.Section>
            );
          })}
        </Card>

        <Group mb={-12}>
          <Text size="lg" weight={500}>
            Are you going to play?
          </Text>
          <Button
            ml="auto"
            size="compact-lg"
            variant="light"
            pl={4}
            color={newGameState.viewOnly ? 'gray' : 'blue'}
            onClick={() => setNewGameState((state) => ({ ...state, viewOnly: !state.viewOnly }))}
          >
            <Group gap={4}>
              {newGameState.viewOnly ? <IconX /> : <IconCheck />}
              {newGameState.viewOnly ? 'No' : 'Yes'}
            </Group>
          </Button>
        </Group>

        {!newGameState.viewOnly && (
          <>
            <Text size="lg" weight={500} mb={-12}>
              {`What's your name?`}
            </Text>
            <TextInput
              value={newGameState.name}
              size="md"
              onChange={(event) => {
                setNewGameState((state) => ({ ...state, name: event.target.value }));
              }}
              placeholder="Your name"
            />
          </>
        )}

        <Group mb={-12}>
          <Text size="lg" weight={500}>
            Max Players
          </Text>
        </Group>
        <NumberInput
          value={newGameState.maxPlayers}
          onChange={(value) => {
            setNewGameState((state) => ({ ...state, maxPlayers: value! }));
          }}
          size="md"
          min={2}
          max={10}
          step={1}
          placeholder="Max players"
        />

        <BuzzTransactionButton
          size="lg"
          mt="md"
          label="Create Game"
          loading={isLoading}
          disabled={!canStart || isLoading}
          buzzAmount={cost}
          onPerformTransaction={() => {
            startGame(newGameState);
          }}
        />
      </Stack>
    </ChoppedLayout>
  );
}
