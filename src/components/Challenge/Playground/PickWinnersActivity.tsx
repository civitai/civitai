import {
  Badge,
  Button,
  Card,
  Group,
  Loader,
  ScrollArea,
  Select,
  Stack,
  Text,
  Textarea,
  TypographyStylesProvider,
} from '@mantine/core';
import { IconPlayerPlay, IconTrophy } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { usePlaygroundStore } from './playground.store';

type Winner = {
  creatorId: number;
  creator: string;
  reason: string;
};

type PickWinnersResult = {
  winners: Winner[];
  process: string;
  outcome: string;
};

const PLACE_COLORS = ['yellow', 'gray', 'orange'] as const;
const PLACE_LABELS = ['1st Place', '2nd Place', '3rd Place'] as const;

export function PickWinnersActivity() {
  const selectedJudgeId = usePlaygroundStore((s) => s.selectedJudgeId);
  const aiModel = usePlaygroundStore((s) => s.aiModel);
  const drafts = usePlaygroundStore((s) => s.drafts);
  const updateDraft = usePlaygroundStore((s) => s.updateDraft);

  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [userMessage, setUserMessage] = useState('');
  const [result, setResult] = useState<PickWinnersResult | null>(null);

  const draft =
    selectedJudgeId != null && selectedJudgeId > 0 ? drafts[selectedJudgeId] : undefined;
  const winnerPrompt = draft?.winnerSelectionPrompt ?? '';

  // Load recent challenges for the select dropdown
  const { data: challengeData, isLoading: challengesLoading } =
    trpc.challenge.getModeratorList.useQuery({
      limit: 50,
    });

  const challengeOptions = useMemo(() => {
    if (!challengeData?.items) return [];
    return challengeData.items.map((c) => ({
      value: String(c.id),
      label: `#${c.id} — ${c.title}${c.theme ? ` (${c.theme})` : ''} [${c.status}]`,
    }));
  }, [challengeData]);

  const mutation = trpc.challenge.playgroundPickWinners.useMutation({
    onSuccess: (data) => setResult(data as PickWinnersResult),
    onError: (error) => showErrorNotification({ error: new Error(error.message) }),
  });

  const handleRun = () => {
    if (!challengeId) return;

    setResult(null);
    mutation.mutate({
      challengeId: parseInt(challengeId, 10),
      judgeId: selectedJudgeId != null && selectedJudgeId > 0 ? selectedJudgeId : undefined,
      promptOverrides:
        draft?.systemPrompt || draft?.winnerSelectionPrompt
          ? {
              systemMessage: draft?.systemPrompt ?? undefined,
              winner: draft?.winnerSelectionPrompt ?? undefined,
            }
          : undefined,
      userMessage: userMessage || undefined,
      aiModel: aiModel || undefined,
    });
  };

  return (
    <Stack gap="sm" h="100%">
      <Select
        label="Challenge"
        placeholder="Select a challenge..."
        description="Pick a completed or active challenge to test winner selection"
        data={challengeOptions}
        value={challengeId}
        onChange={setChallengeId}
        searchable
        nothingFoundMessage={challengesLoading ? 'Loading...' : 'No challenges found'}
        rightSection={challengesLoading ? <Loader size="xs" /> : undefined}
      />
      <Textarea
        label="Winner Selection Prompt (override)"
        placeholder="Leave empty to use judge's default"
        autosize
        minRows={3}
        maxRows={8}
        value={winnerPrompt}
        onChange={(e) => {
          const id = selectedJudgeId != null && selectedJudgeId > 0 ? selectedJudgeId : null;
          if (id != null) updateDraft(id, { winnerSelectionPrompt: e.currentTarget.value || null });
        }}
      />
      <Textarea
        label="User Message (override)"
        placeholder="Leave empty to use default (Theme + Entries JSON)"
        autosize
        minRows={2}
        maxRows={6}
        value={userMessage}
        onChange={(e) => setUserMessage(e.currentTarget.value)}
      />
      <Button
        leftSection={<IconPlayerPlay size={16} />}
        onClick={handleRun}
        loading={mutation.isLoading}
        disabled={!challengeId}
      >
        Pick Winners
      </Button>

      {result && (
        <Card withBorder>
          <Stack gap="md">
            <Text fw={600} size="sm">
              Winners
            </Text>
            {result.winners.map((winner, i) => (
              <Card key={winner.creatorId} withBorder p="sm">
                <Group gap="sm" mb="xs">
                  <IconTrophy
                    size={16}
                    color={`var(--mantine-color-${PLACE_COLORS[i] ?? 'gray'}-6)`}
                  />
                  <Badge color={PLACE_COLORS[i] ?? 'gray'} variant="light" size="sm">
                    {PLACE_LABELS[i] ?? `${i + 1}th`}
                  </Badge>
                  <Text fw={600} size="sm">
                    {winner.creator}
                  </Text>
                </Group>
                <Text size="sm" c="dimmed">
                  {winner.reason}
                </Text>
              </Card>
            ))}

            {result.process && (
              <div>
                <Text fw={600} size="sm" mb="xs">
                  Judging Process
                </Text>
                <ScrollArea mah={200}>
                  <TypographyStylesProvider>
                    <div dangerouslySetInnerHTML={{ __html: result.process }} />
                  </TypographyStylesProvider>
                </ScrollArea>
              </div>
            )}

            {result.outcome && (
              <div>
                <Text fw={600} size="sm" mb="xs">
                  Outcome
                </Text>
                <ScrollArea mah={200}>
                  <TypographyStylesProvider>
                    <div dangerouslySetInnerHTML={{ __html: result.outcome }} />
                  </TypographyStylesProvider>
                </ScrollArea>
              </div>
            )}
          </Stack>
        </Card>
      )}
    </Stack>
  );
}
