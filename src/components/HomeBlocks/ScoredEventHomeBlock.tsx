import { ActionIcon, Button, Card, Group, Stack, Text } from '@mantine/core';
import { IconHanger, IconUsers, IconX } from '@tabler/icons-react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useMutateEvent, useTeamColor } from '~/components/Events/events.utils';
import { JoinEventButton } from '~/components/Events/ScoredEvent/JoinEventButton';
import PlaceHatModal from '~/components/Events/ScoredEvent/PlaceHatModal';
import { useEventPromos } from '~/components/Events/useEventPromos';
import {
  scoredEventHomeBlockCopy,
  scoredEventHomeBlockView,
} from '~/components/HomeBlocks/scored-event-home-block.utils';
import { NextLink } from '~/components/NextLink/NextLink';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { RouterOutput } from '~/types/router';
import { abbreviateNumber } from '~/utils/number-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

type EventData = RouterOutput['event']['getData'];

/**
 * A scored event's home block: where the teams stand and what to do next. Read from the event's own
 * gated endpoints, never the shared home-block cache, and everything but the copy is derived from
 * the event definition, so the next scored event needs only a row and its promo copy.
 */
export function ScoredEventHomeBlock({
  event,
  data,
  onDismiss,
}: {
  event: string;
  data: EventData;
  onDismiss: () => void;
}) {
  const currentUser = useCurrentUser();
  const teamColor = useTeamColor();
  const utils = trpc.useUtils();
  const promo = useEventPromos().find((p) => p.event === event);

  const { data: eventCosmetic } = trpc.event.getCosmetic.useQuery(
    { event },
    { enabled: !!currentUser }
  );
  const team = eventCosmetic?.obtained
    ? (eventCosmetic.cosmetic?.data as { team?: string } | undefined)?.team
    : undefined;
  const { data: standings } = trpc.event.getStandings.useQuery({ event });
  const { data: hats = [] } = trpc.event.getMyHats.useQuery({ event }, { enabled: !!team });
  const { activateCosmetic, equipping } = useMutateEvent();

  const copy = scoredEventHomeBlockCopy(data, promo?.homeBlock);
  const view = scoredEventHomeBlockView({ data, standings, team, hats });
  const eventHref = `/events/${event}`;
  const rosterHref = promo?.teamHref ?? (data.joinable ? `${eventHref}/team` : undefined);

  const join = async () => {
    try {
      await activateCosmetic({ event });
      await utils.event.getMyHats.invalidate({ event });
    } catch (e) {
      showErrorNotification({ title: 'Unable to join', error: e as Error });
    }
  };
  const placeHat = (index: number) =>
    dialogStore.trigger({
      component: PlaceHatModal,
      props: { event, hat: hats[index], myHats: hats },
    });

  return (
    <Card withBorder radius="lg" className="relative p-4 @md:p-8" data-testid="event-home-block">
      <ActionIcon
        variant="subtle"
        color="gray"
        className="absolute right-3 top-3"
        aria-label="Hide this event"
        onClick={onDismiss}
      >
        <IconX size={18} />
      </ActionIcon>
      <Group align="start" justify="space-between" gap="xl" wrap="wrap">
        <Stack gap="sm" className="min-w-0 flex-1 basis-80">
          <Stack gap={2}>
            {copy.eyebrow && (
              <Text size="sm" fw={600} tt="uppercase" c="dimmed">
                {copy.eyebrow}
              </Text>
            )}
            <Text className="text-2xl font-bold">{copy.title}</Text>
            {copy.body && view.state !== 'ended' && <Text c="dimmed">{copy.body}</Text>}
          </Stack>

          {view.state === 'ended' && (
            <Text fw={600}>
              {view.winner ? `Team ${view.winner} won.` : 'The results are being settled.'}
            </Text>
          )}
          {view.state === 'joined' && (
            <Text fw={600} c={teamColor(view.team)}>
              Team {view.team}
              {view.rank ? ` · #${view.rank}` : ''} · {view.hatsPlaced} of {view.hatsOwned}{' '}
              {view.hatsOwned === 1 ? 'hat' : 'hats'} placed
            </Text>
          )}

          <Group gap="xs">
            {view.state === 'join' && <JoinEventButton onClick={join} loading={equipping} />}
            {view.state === 'joined' && view.nextHatIndex >= 0 && (
              <Button
                radius="xl"
                leftSection={<IconHanger size={18} />}
                onClick={() => placeHat(view.nextHatIndex)}
              >
                Hat your work
              </Button>
            )}
            <Button component={NextLink} href={eventHref} radius="xl" variant="light">
              {view.state === 'ended' ? 'See the results' : copy.cta}
            </Button>
            {view.state === 'joined' && rosterHref && (
              <Button
                component={NextLink}
                href={rosterHref}
                radius="xl"
                variant="subtle"
                leftSection={<IconUsers size={18} />}
              >
                Team rosters
              </Button>
            )}
          </Group>
        </Stack>

        {standings && standings.teams.length > 0 && (
          <Stack gap={6} className="min-w-48" data-testid="event-home-block-standings">
            {standings.teams.map((t) => (
              <Group key={t.team} gap="xs" wrap="nowrap" justify="space-between">
                <Group gap={8} wrap="nowrap">
                  <Text size="sm" c="dimmed" className="w-5 tabular-nums">
                    #{t.rank}
                  </Text>
                  <span
                    aria-hidden
                    className="inline-block size-3 rounded-full"
                    style={{ background: teamColor(t.team) }}
                  />
                  <Text size="sm" fw={t.team === team ? 700 : 500}>
                    {t.team}
                  </Text>
                </Group>
                <Text size="sm" fw={600} className="tabular-nums">
                  {abbreviateNumber(t.score)}
                </Text>
              </Group>
            ))}
          </Stack>
        )}
      </Group>
    </Card>
  );
}
