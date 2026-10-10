import { Badge, Button, Group, Popover, Skeleton, Stack, Text } from '@mantine/core';
import { IconArrowsMove } from '@tabler/icons-react';
import dynamic from 'next/dynamic';
import type { ReactNode } from 'react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useTeamColor } from '~/components/Events/events.utils';
import { HatStats } from '~/components/Events/ScoredEvent/HatStats';
import { NextLink } from '~/components/NextLink/NextLink';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { getEventDecorationDefinition } from '~/shared/constants/event-decoration.constants';
import type { CosmeticEntity } from '~/shared/utils/prisma/enums';
import type { RouterOutput } from '~/types/router';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const PlaceHatModal = dynamic(() => import('~/components/Events/ScoredEvent/PlaceHatModal'), {
  ssr: false,
});

/** The content a worn event decoration sits on. */
export type EventDecorationEntity = { entityType: CosmeticEntity; entityId: number };

type WornHat = NonNullable<RouterOutput['event']['getWornHat']>;

/**
 * The popover a click on a card's hat opens: which hat it is, who wears it, what it has earned on
 * this content, and a way to the event. Its read waits for the first open, so a feed of hatted
 * cards costs no request.
 */
export function WornHatPopover({
  event,
  wornOn,
  opened,
  onChange,
  children,
}: {
  event: string;
  wornOn: EventDecorationEntity;
  opened: boolean;
  onChange: (opened: boolean) => void;
  /** The hat itself, which the popover hangs from. */
  children: ReactNode;
}) {
  const { data, isLoading, isError } = trpc.event.getWornHat.useQuery(
    { event, ...wornOn },
    { enabled: opened }
  );
  const definition = getEventDecorationDefinition(event);

  return (
    <Popover
      opened={opened}
      onChange={onChange}
      position="bottom-start"
      width={300}
      radius="md"
      shadow="md"
      withArrow
      // The arrow points at the hat. Mantine's default pins it 5px from the dropdown's start edge.
      arrowPosition="center"
      arrowSize={10}
    >
      <Popover.Target>{children}</Popover.Target>
      {/* Portalled, but React still bubbles its clicks to the card underneath. */}
      <Popover.Dropdown onClick={(e) => e.stopPropagation()} data-testid="worn-hat-popover">
        <Stack gap="xs">
          {isLoading ? (
            <Stack gap={8}>
              <Skeleton height={18} width="70%" />
              <Skeleton height={14} width="50%" />
              <Skeleton height={36} />
            </Stack>
          ) : isError ? (
            <Text size="sm" c="dimmed">
              Stats unavailable
            </Text>
          ) : !data ? (
            // The card was drawn before its hat moved, or the content is not public.
            <Text size="sm" c="dimmed">
              No stats to show here.
            </Text>
          ) : (
            <WornHatDetails event={event} hat={data} wornOn={wornOn} />
          )}
          <Button
            component={NextLink}
            href={`/events/${event}`}
            radius="xl"
            fullWidth
            onClick={() => onChange(false)}
          >
            {definition?.eventLinkLabel ?? 'See the event'}
          </Button>
          {data?.team && (
            <Text size="xs" c="dimmed" ta="center">
              Scores for Team {data.team} while it&apos;s worn
            </Text>
          )}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

function WornHatDetails({
  event,
  hat,
  wornOn,
}: {
  event: string;
  hat: WornHat;
  wornOn: EventDecorationEntity;
}) {
  const currentUser = useCurrentUser();
  const utils = trpc.useUtils();
  const teamColor = useTeamColor();
  const mine = !!currentUser && hat.owner?.id === currentUser.id;

  // The hat-centric picker needs the caller's own hats, read only when they ask to move one.
  const move = async () => {
    try {
      const myHats = await utils.event.getMyHats.fetch({ event });
      const mineHere = myHats.find(
        (h) =>
          h.cosmeticId === hat.cosmeticId &&
          h.placedOn?.entityType === wornOn.entityType &&
          h.placedOn.entityId === wornOn.entityId
      );
      if (!mineHere) throw new Error('This hat has already moved.');
      dialogStore.trigger({ component: PlaceHatModal, props: { event, hat: mineHere, myHats } });
    } catch (error) {
      showErrorNotification({ title: "Couldn't move this hat", error: error as Error });
    }
  };

  return (
    <>
      <Group gap="xs" wrap="nowrap">
        <Text fw={700} truncate>
          {hat.name}
        </Text>
        {hat.team && (
          <Badge color={teamColor(hat.team)} variant="light" radius="sm" className="shrink-0">
            {hat.team}
          </Badge>
        )}
      </Group>
      {mine ? (
        <Group gap={6}>
          <Badge color="gray" variant="light" radius="sm">
            Your hat
          </Badge>
          <Badge
            component="button"
            type="button"
            onClick={move}
            variant="light"
            radius="xl"
            leftSection={<IconArrowsMove size={12} />}
            className="cursor-pointer"
          >
            Move
          </Badge>
        </Group>
      ) : hat.owner ? (
        <Group gap={6} wrap="nowrap">
          <Text size="sm" c="dimmed" className="shrink-0">
            Worn by
          </Text>
          <UserAvatar
            userId={hat.owner.id}
            user={{ ...hat.owner, deletedAt: null }}
            avatarSize="xs"
            withUsername
            linkToProfile
          />
        </Group>
      ) : null}
      <HatStats stats={hat} color={hat.team ? teamColor(hat.team) : undefined} />
    </>
  );
}
