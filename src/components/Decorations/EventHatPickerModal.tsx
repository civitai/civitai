import {
  Badge,
  Button,
  Center,
  Group,
  Loader,
  Modal,
  Stack,
  Text,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { IconConfetti, IconHanger, IconPinned, IconPlus, IconTrophy } from '@tabler/icons-react';
import clsx from 'clsx';
import { NextLink } from '~/components/NextLink/NextLink';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useEquipContentDecoration } from '~/components/Cosmetics/cosmetics.util';
import type { HatState } from '~/components/Decorations/event-hat-picker.utils';
import {
  canPutOn,
  getHatState,
  pickDefaultHat,
} from '~/components/Decorations/event-hat-picker.utils';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useMutateEvent, useTeamColor } from '~/components/Events/events.utils';
import { PreviewCard } from '~/components/Modals/CardDecorationModal';
import type { Props as CardDecorationModalProps } from '~/components/Modals/CardDecorationModal';
import {
  SpotlightBorderCard,
  SpotlightGlow,
  SpotlightSurface,
} from '~/components/SpotlightCard/SpotlightBorderCard';
import type { EventDecorationData } from '~/shared/constants/event-decoration.constants';
import { getEventDecorationDefinition } from '~/shared/constants/event-decoration.constants';
import type { RouterOutput } from '~/types/router';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import classes from './EventHatPickerModal.module.scss';

type MyHat = RouterOutput['event']['getMyHats'][number];
export type Props = Pick<CardDecorationModalProps, 'entityType' | 'entityId' | 'image'> & {
  /** Fixed when the menu opens the picker, so the event window closing meanwhile cannot blank it. */
  event: string;
};

const NEUTRAL = 'var(--mantine-color-blue-5)';
const PREVIEW_WIDTH = 200;

/**
 * Puts one of the viewer's event hats on this content: the content wearing the chosen hat, what it
 * does for the team, and every hat they own with where it is now. With no hats, it says how to get
 * one. The equip is the same mutation the event page uses, so ownership, the event window and the
 * move cooldown are enforced in one place.
 */
export default function EventHatPickerModal({ entityType, entityId, image, event }: Props) {
  const dialog = useDialogContext();
  const utils = trpc.useUtils();
  const teamColor = useTeamColor();
  const definition = getEventDecorationDefinition(event);

  const { data: eventCosmetic, isLoading: loadingCosmetic } = trpc.event.getCosmetic.useQuery({
    event,
  });
  const {
    data: hats = [],
    isLoading: loadingHats,
    dataUpdatedAt: hatsFetchedAt,
  } = trpc.event.getMyHats.useQuery({ event });
  // Re-reads the clock every half minute, so a cooling hat unlocks while the picker is open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const { data: standings } = trpc.event.getStandings.useQuery({ event });
  const { equip, isLoading: equipping } = useEquipContentDecoration();
  const { activateCosmetic, equipping: joining } = useMutateEvent();

  const joined = !!eventCosmetic?.obtained;
  const team = joined
    ? (eventCosmetic?.cosmetic?.data as { team?: string } | undefined)?.team
    : undefined;
  const color = (team && teamColor(team)) ?? NEUTRAL;
  const context = {
    entityType,
    entityId,
    joinCosmeticId: eventCosmetic?.cosmetic?.id,
    now,
    fetchedAt: hatsFetchedAt,
  };

  const [selectedKey, setSelectedKey] = useState<string>();
  const [hoveredKey, setHoveredKey] = useState<string>();
  const selected = hats.find((h) => hatKey(h) === selectedKey) ?? pickDefaultHat(hats, context);
  const shown = hats.find((h) => hatKey(h) === hoveredKey) ?? selected;
  const selectedState = selected && getHatState(selected, context);

  const put = async () => {
    if (!selected) return;
    try {
      await equip({
        equippedToType: entityType,
        equippedToId: entityId,
        cosmeticId: selected.cosmeticId,
        claimKey: selected.claimKey,
      });
      await utils.event.getMyHats.invalidate({ event });
      dialog.onClose();
    } catch {
      // The equip hook shows the error.
    }
  };

  const join = async () => {
    try {
      await activateCosmetic({ event });
      await Promise.all([
        utils.event.getMyHats.invalidate({ event }),
        utils.user.getCosmetics.invalidate(),
      ]);
    } catch (e) {
      showErrorNotification({ title: 'Unable to join', error: e as Error });
    }
  };

  const handleClose = () => {
    if (equipping || joining) return;
    dialog.onClose();
  };

  const title = `Add ${definition?.label ?? 'Party Hat'}`;
  const shopHref = `/events/${event}#team-hats`;

  let body: ReactNode;
  if (loadingCosmetic || loadingHats) {
    body = (
      <Center py={80}>
        <Loader />
      </Center>
    );
  } else if (!selected || !shown || !selectedState) {
    const ghost =
      standings?.teamHats?.find((h) => h.team === team)?.url ??
      standings?.teamHats?.find((h) => h.url)?.url;
    body = (
      <SpotlightSurface className="flex flex-col items-center gap-6 rounded-xl border border-solid border-gray-3 bg-white p-6 sm:flex-row sm:items-start dark:border-dark-4 dark:bg-dark-6">
        <SpotlightGlow color="light-dark(rgba(0,0,0,0.04), rgba(255,255,255,0.06))" size={500} />
        {/* The modal's sticky header sits flush on its body, so a hat gets only this room,
            and growing on hover would carry it under the header. */}
        <div className={classes.ghost}>
          <div className="pt-4 [--event-decoration-allowance:16px] [--event-decoration-grow:1]">
            <PreviewCard
              image={image}
              hat={ghost ? ghostHat(event, ghost) : undefined}
              width={PREVIEW_WIDTH}
            />
          </div>
        </div>
        <Stack gap="md" className="relative flex-1">
          <Stack gap={6}>
            <Eyebrow>{definition?.label ?? 'Party Hat'}</Eyebrow>
            <Title order={3}>You don&apos;t have a hat yet</Title>
            <Text size="sm" c="dimmed">
              {joined
                ? 'Your team’s designs are in the event shop, and every hat you wear scores for your team.'
                : 'Join a team for the birthday and you get a free Party Cap in your team’s colour. More designs are in the event shop, and every hat you wear scores for your team.'}
            </Text>
          </Stack>
          {!joined && !!standings?.teams.length && (
            <Group gap={6}>
              {standings.teams.map((t) => (
                <Badge key={t.team} radius="xl" variant="filled" color={t.team.toLowerCase()}>
                  {t.team}
                </Badge>
              ))}
            </Group>
          )}
          <Group gap="sm">
            {!joined && (
              <Button
                radius="xl"
                onClick={join}
                loading={joining}
                leftSection={<IconConfetti size={18} />}
              >
                Join a team, get a free cap
              </Button>
            )}
            <Button
              component={NextLink}
              href={shopHref}
              radius="xl"
              variant={joined ? 'filled' : 'default'}
              onClick={handleClose}
            >
              Browse the event shop
            </Button>
          </Group>
        </Stack>
      </SpotlightSurface>
    );
  } else {
    const rank = team ? standings?.teams.find((t) => t.team === team)?.rank : undefined;
    const worn = hats.filter((h) => h.placedOn).length;
    body = (
      <Stack gap="lg">
        <SpotlightSurface
          color={color}
          className="flex flex-col items-center gap-6 rounded-xl border border-solid border-gray-3 bg-white p-5 sm:flex-row sm:items-start dark:border-dark-4 dark:bg-dark-6"
        >
          <SpotlightGlow color={`color-mix(in srgb, ${color} 12%, transparent)`} size={500} />
          {/* The modal's sticky header sits flush on its body, so a hat gets only this room,
              and growing on hover would carry it under the header. */}
          <div className="pt-4 [--event-decoration-allowance:16px] [--event-decoration-grow:1]">
            <PreviewCard image={image} hat={shown.data} width={PREVIEW_WIDTH} />
          </div>
          <Stack gap="md" className="relative min-w-0 flex-1">
            <Stack gap={6}>
              {team && (
                <Badge
                  radius="xl"
                  variant="light"
                  color={team.toLowerCase()}
                  leftSection={<IconConfetti size={14} />}
                  className="self-start"
                >
                  Team {team}
                </Badge>
              )}
              <Title order={3}>{shown.name}</Title>
              <Text size="sm" c="dimmed">
                Wear it here and it scores for {team ? `Team ${team}` : 'your team'} from the moment
                it goes on. You can move a hat to another post every{' '}
                {Math.round((definition?.moveCooldownMs ?? 0) / 60_000)} minutes.
              </Text>
            </Stack>
            <Group gap="lg">
              <Stat
                icon={<IconHanger size={18} />}
                value={hats.length}
                label="hats owned"
                color={color}
              />
              <Stat
                icon={<IconPinned size={18} />}
                value={worn}
                label="on your posts"
                color={color}
              />
              {rank && (
                <Stat
                  icon={<IconTrophy size={18} />}
                  value={`#${rank}`}
                  label="team rank"
                  color={color}
                />
              )}
            </Group>
          </Stack>
        </SpotlightSurface>

        <Stack gap={8}>
          <Eyebrow>Your hats · {hats.length}</Eyebrow>
          <div
            className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-2"
            onMouseLeave={() => setHoveredKey(undefined)}
          >
            {hats.map((hat) => (
              <HatTile
                key={hatKey(hat)}
                hat={hat}
                state={getHatState(hat, context)}
                selected={hat === selected}
                color={color}
                team={team}
                onSelect={() => setSelectedKey(hatKey(hat))}
                onHover={() => setHoveredKey(hatKey(hat))}
              />
            ))}
            {joined && (
              <UnstyledButton
                component={NextLink}
                href={shopHref}
                onClick={handleClose}
                className="flex w-36 shrink-0 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-gray-4 p-2 text-center hover:bg-gray-0 dark:border-dark-3 dark:hover:bg-dark-5"
              >
                <IconPlus size={20} color={color} />
                <Text size="sm" fw={700} c={color}>
                  Get more hats
                </Text>
              </UnstyledButton>
            )}
          </div>
        </Stack>

        <Group justify="space-between" gap="sm">
          <Text size="sm" c="dimmed" className="min-w-0 flex-1">
            {footnote(selected.name, selectedState)}
          </Text>
          <Group gap="sm">
            <Button radius="xl" variant="default" onClick={handleClose}>
              Cancel
            </Button>
            <Button
              radius="xl"
              onClick={put}
              loading={equipping}
              disabled={!canPutOn(selectedState)}
            >
              {selectedState.kind === 'elsewhere' ? 'Move it here' : `Put on ${selected.name}`}
            </Button>
          </Group>
        </Group>
      </Stack>
    );
  }

  return (
    <Modal
      {...dialog}
      onClose={handleClose}
      title={<Text fw={700}>{title}</Text>}
      size="xl"
      radius="md"
      closeOnClickOutside={!equipping && !joining}
      closeOnEscape={!equipping && !joining}
    >
      {body}
    </Modal>
  );
}

function hatKey(hat: Pick<MyHat, 'cosmeticId' | 'claimKey'>) {
  return `${hat.cosmeticId}:${hat.claimKey}`;
}

// A team cap drawn as a hint of what joining gets you.
function ghostHat(event: string, url: string): EventDecorationData {
  return { type: 'hat', event, url };
}

function placeName(state: Extract<HatState, { kind: 'elsewhere' }>) {
  return state.title ? `“${state.title}”` : `your ${state.entityType.toLowerCase()}`;
}

function footnote(name: string, state: HatState) {
  switch (state.kind) {
    case 'elsewhere':
      return `${name} is on ${placeName(state)} now. Putting it here moves it.`;
    case 'cooldown':
      return `${name} was moved recently. It can move again in ${state.minutes} min.`;
    case 'here':
      return `${name} is already on this post.`;
    default:
      return 'Hats score for your team while they are on.';
  }
}

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <Text size="xs" fw={700} tt="uppercase" c="dimmed" lts={0.5}>
      {children}
    </Text>
  );
}

function Stat({
  icon,
  value,
  label,
  color,
}: {
  icon: ReactNode;
  value: ReactNode;
  label: string;
  color: string;
}) {
  return (
    <Group gap={8} wrap="nowrap" className="min-w-0">
      <Center
        className="size-8 shrink-0 rounded-full"
        style={{ background: `color-mix(in srgb, ${color} 15%, transparent)`, color }}
      >
        {icon}
      </Center>
      <Stack gap={0} className="min-w-0">
        <Text fw={800} size="lg" lh={1.1} className="tabular-nums">
          {value}
        </Text>
        <Text size="xs" c="dimmed" truncate>
          {label}
        </Text>
      </Stack>
    </Group>
  );
}

// 'team' is the viewer's team palette.
const CHIP: Record<HatState['kind'], { color: string; label: (s: HatState) => string }> = {
  ready: { color: 'green', label: () => 'Ready' },
  free: { color: 'team', label: () => 'Free with your team' },
  elsewhere: {
    color: 'gray',
    label: (s) => (s.kind === 'elsewhere' ? `On ${placeName(s)}` : ''),
  },
  cooldown: {
    color: 'orange',
    label: (s) => (s.kind === 'cooldown' ? `Moves again in ${s.minutes}m` : ''),
  },
  here: { color: 'gray', label: () => 'On this post' },
};

function HatTile({
  hat,
  state,
  selected,
  color,
  team,
  onSelect,
  onHover,
}: {
  hat: MyHat;
  state: HatState;
  selected: boolean;
  color: string;
  team?: string;
  onSelect: () => void;
  onHover: () => void;
}) {
  const chip = CHIP[state.kind];
  return (
    <UnstyledButton
      aria-pressed={selected}
      onClick={onSelect}
      onMouseEnter={onHover}
      onFocus={onHover}
      className="w-36 shrink-0"
    >
      <SpotlightBorderCard
        color={color}
        size={160}
        className={clsx(selected && 'p-0.5')}
        style={selected ? { background: color } : undefined}
      >
        <Stack gap={4} align="center" p={8}>
          <div className="w-14">
            <EdgeMedia src={hat.data.url} width={128} alt="" />
          </div>
          <Text size="sm" fw={700} lineClamp={1} ta="center">
            {hat.name}
          </Text>
          <Badge
            size="xs"
            radius="sm"
            variant="light"
            tt="none"
            color={chip.color === 'team' ? team?.toLowerCase() ?? 'blue' : chip.color}
            maw="100%"
          >
            {chip.label(state)}
          </Badge>
        </Stack>
      </SpotlightBorderCard>
    </UnstyledButton>
  );
}
