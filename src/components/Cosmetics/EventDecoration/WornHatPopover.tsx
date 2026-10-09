import { Anchor, Badge, Button, Group, Popover, Skeleton, Stack, Text } from '@mantine/core';
import dynamic from 'next/dynamic';
import type { ReactNode } from 'react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useTeamColor } from '~/components/Events/events.utils';
import { NextLink } from '~/components/NextLink/NextLink';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { getEventDecorationDefinition } from '~/shared/constants/event-decoration.constants';
import type { CosmeticEntity } from '~/shared/utils/prisma/enums';
import type { RouterOutput } from '~/types/router';
import { showErrorNotification } from '~/utils/notifications';
import { abbreviateNumber } from '~/utils/number-helpers';
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
      width={280}
      radius="md"
      shadow="md"
      withArrow
    >
      <Popover.Target>{children}</Popover.Target>
      {/* Portalled, but React still bubbles its clicks to the card underneath. */}
      <Popover.Dropdown onClick={(e) => e.stopPropagation()} data-testid="worn-hat-popover">
        <Stack gap="xs">
          <Text size="xs" fw={700} c="dimmed" tt="uppercase" style={{ letterSpacing: 0.5 }}>
            {definition?.eventTitle ?? 'Event'} · Team hat
          </Text>
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
            // The card was drawn before its hat moved or came off.
            <Text size="sm" c="dimmed">
              This hat has moved on.
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
        <Group gap="xs">
          <Text size="sm" fw={600}>
            Your hat
          </Text>
          <Anchor component="button" type="button" size="sm" onClick={move}>
            Move it
          </Anchor>
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
      <Group grow gap="xs">
        <WornHatStat value={hat.points} label="points" />
        <WornHatStat value={hat.impressions} label="views" />
        <WornHatStat value={hat.reactions} label="reactions" />
      </Group>
    </>
  );
}

function WornHatStat({ value, label }: { value: number; label: string }) {
  return (
    <Stack gap={0} align="center" className="rounded-md bg-gray-1 py-1.5 dark:bg-dark-5">
      <Text fw={800} className="tabular-nums" lh={1.2}>
        {abbreviateNumber(value)}
      </Text>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
    </Stack>
  );
}
