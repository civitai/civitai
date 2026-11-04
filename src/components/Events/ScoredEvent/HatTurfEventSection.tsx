import { Button, Paper, Text } from '@mantine/core';
import { usePlayableEventDecoration } from '~/components/Decorations/usePlayableEventDecoration';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * Join or leave Hat Turf from the event page. Only for a signed-in viewer on a team, while turf runs
 * for this event on a surface they can see (the same gate as the account setting).
 */
export function HatTurfEventSection({ event, team }: { event: string; team?: string }) {
  const user = useCurrentUser();
  const features = useFeatureFlags();
  const definition = usePlayableEventDecoration(
    'Image',
    !!user && !!team && (!!features.hatTurfImageDetail || !!features.hatTurfFeedCard)
  );
  const playable = definition?.event === event;
  const utils = trpc.useUtils();
  const { data: stock } = trpc.hatTurf.getStock.useQuery(
    { event },
    { enabled: playable, staleTime: 30_000 }
  );
  const setOptIn = trpc.hatTurf.setOptIn.useMutation({
    onSuccess: () => {
      void utils.hatTurf.getStock.invalidate();
      void utils.hatTurf.getSummaries.invalidate();
    },
    onError: (error) => showErrorNotification({ title: "Couldn't update Hat Turf", error }),
  });
  if (!playable || !stock || stock.mode === 'off') return null;

  const joined = stock.optedIn;
  return (
    <Paper
      withBorder
      radius="md"
      p="md"
      className="flex flex-wrap items-center justify-between gap-3"
      data-testid="hat-turf-event-section"
    >
      <div>
        <Text fw={700}>Hat Turf</Text>
        <Text size="sm" c="dimmed">
          {joined
            ? "You're in. Put your team's hat on any picture to claim it for your team."
            : "Put your team's hat on any picture to claim it for your team."}
        </Text>
      </div>
      <Button
        size="sm"
        color={joined ? 'gray' : 'yellow'}
        variant={joined ? 'default' : 'filled'}
        loading={setOptIn.isPending}
        onClick={() => setOptIn.mutate({ event, optedIn: !joined })}
      >
        {joined ? 'Leave Hat Turf' : 'Join Hat Turf'}
      </Button>
    </Paper>
  );
}
