import clsx from 'clsx';
import { useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Center,
  Loader,
  Modal,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  UnstyledButton,
} from '@mantine/core';
import { useEquipContentDecoration } from '~/components/Cosmetics/cosmetics.util';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { EventContentThumb } from '~/components/Events/ScoredEvent/EventContentThumb';
import type { PlaceableTab } from '~/components/Events/ScoredEvent/scored-event.utils';
import {
  defaultPlaceableTab,
  PLACEABLE_TABS,
  placeableTabCount,
} from '~/components/Events/ScoredEvent/scored-event.utils';
import { NextLink } from '~/components/NextLink/NextLink';
import type { EventDecorationData } from '~/shared/constants/event-decoration.constants';
import { getEventDecorationDefinition } from '~/shared/constants/event-decoration.constants';
import type { CosmeticEntity } from '~/shared/utils/prisma/enums';
import type { RouterOutput } from '~/types/router';
import { getDisplayName } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

type MyHat = RouterOutput['event']['getMyHats'][number];

const TAB_COPY: Record<
  PlaceableTab,
  { label: string; intro: string; empty: string; cta: string; href: string }
> = {
  Image: {
    label: 'Images',
    intro: 'Your published images, newest first.',
    empty: 'No published images yet. Post one and come back.',
    cta: 'Create a post',
    href: '/posts/create',
  },
  Model: {
    label: 'Models',
    intro: 'Your published models, newest version first.',
    empty: "You haven't published a model yet.",
    cta: 'Upload a model',
    href: '/models/create',
  },
  Article: {
    label: 'Articles',
    intro: 'Your published articles, newest first.',
    empty: 'No published articles yet.',
    cta: 'Write an article',
    href: '/articles/create',
  },
};

// One tab's pages. Called once per type in a fixed order; a type the hat can't go on never fetches.
function usePlaceable(event: string, entityType: PlaceableTab, enabled: boolean) {
  const query = trpc.event.getPlaceableContentPage.useInfiniteQuery(
    { event, entityType },
    { enabled, getNextPageParam: (page) => page.nextCursor ?? undefined }
  );
  // A model or article published between two pages shifts the offset: drop the repeat.
  const items = useMemo(() => {
    const seen = new Set<number>();
    return (query.data?.pages.flatMap((p) => p.items) ?? []).filter(
      (i) => !seen.has(i.entityId) && !!seen.add(i.entityId)
    );
  }, [query.data]);
  return { ...query, items };
}

/**
 * Pick which of your own posts a hat goes on, one tab per type it can go on. The equip is the same
 * mutation the content card's menu uses, so ownership, the event window and the move cooldown are
 * enforced in one place.
 */
export default function PlaceHatModal({
  event,
  hat,
  myHats,
}: {
  event: string;
  hat: MyHat;
  myHats: MyHat[];
}) {
  const dialog = useDialogContext();
  const utils = trpc.useUtils();
  const allowed = getEventDecorationDefinition(event)?.entityTypes ?? [];
  const tabs = PLACEABLE_TABS.filter((t) => allowed.includes(t));
  const lists = {
    Image: usePlaceable(event, 'Image', tabs.includes('Image')),
    Model: usePlaceable(event, 'Model', tabs.includes('Model')),
    Article: usePlaceable(event, 'Article', tabs.includes('Article')),
  };
  const state = Object.fromEntries(
    tabs.map((t) => [
      t,
      { count: lists[t].items.length, more: !!lists[t].hasNextPage, loaded: !lists[t].isLoading },
    ])
  );
  const [picked, setPicked] = useState<PlaceableTab>();
  const tab = picked ?? defaultPlaceableTab(tabs, state, hat.placedOn?.entityType);
  const list = tab ? lists[tab] : undefined;
  const { equip, isLoading: equipping } = useEquipContentDecoration();

  const wearer = (entityType: string, entityId: number) =>
    myHats.find(
      (h) =>
        h.placedOn?.entityType === entityType &&
        h.placedOn.entityId === entityId &&
        !(h.cosmeticId === hat.cosmeticId && h.claimKey === hat.claimKey)
    );

  const place = async (entityType: CosmeticEntity, entityId: number) => {
    try {
      await equip({
        equippedToType: entityType,
        equippedToId: entityId,
        cosmeticId: hat.cosmeticId,
        claimKey: hat.claimKey,
      });
      await utils.event.getMyHats.invalidate({ event });
      dialog.onClose();
    } catch {
      // The equip hook shows the error.
    }
  };

  return (
    <Modal {...dialog} title={`Where should ${hat.name} go?`} size="xl" radius="md">
      <Stack gap="md">
        {tabs.length > 1 && (
          <SegmentedControl
            value={tab}
            onChange={(v) => setPicked(v as PlaceableTab)}
            data={tabs.map((t) => ({
              value: t,
              label: `${TAB_COPY[t].label} ${placeableTabCount(state[t])}`.trim(),
            }))}
          />
        )}
        {tab && (
          <Text size="sm" c="dimmed">
            {TAB_COPY[tab].intro} A hat scores from the moment it goes on.
          </Text>
        )}
        {!tab || !list ? (
          <Text c="dimmed" ta="center" py="xl">
            Nothing you publish can wear this hat.
          </Text>
        ) : list.isLoading ? (
          <Center py="xl">
            <Loader />
          </Center>
        ) : !list.items.length ? (
          <Stack align="center" gap="sm" py="xl" data-testid="placeable-empty">
            <Text c="dimmed" ta="center">
              {TAB_COPY[tab].empty}
            </Text>
            <Button component={NextLink} href={TAB_COPY[tab].href} variant="light" size="sm">
              {TAB_COPY[tab].cta}
            </Button>
          </Stack>
        ) : (
          // Padded so a worn hat has room past the first row's and first column's corners. The
          // modal crops what reaches further, so the hat does not grow on hover in here.
          <SimpleGrid
            cols={{ base: 2, xs: 3, sm: 4 }}
            spacing="sm"
            className="pl-6 pr-2 pt-6 [--event-decoration-grow:1]"
          >
            {list.items.map((c) => {
              const other = wearer(c.entityType, c.entityId);
              const current =
                hat.placedOn?.entityType === c.entityType && hat.placedOn.entityId === c.entityId;
              const badge =
                c.entityType === 'Model'
                  ? c.modelType
                    ? getDisplayName(c.modelType)
                    : 'Model'
                  : c.entityType === 'Article'
                  ? 'Article'
                  : null;
              return (
                <UnstyledButton
                  key={`${c.entityType}:${c.entityId}`}
                  data-tile={`${c.entityType}:${c.entityId}`}
                  // The post wearing this hat can't be picked. It is not a button at all: a
                  // disabled one swallows real clicks on the hat inside it, so it would not burst.
                  component={current ? 'div' : 'button'}
                  disabled={!current && equipping}
                  onClick={current ? undefined : () => place(c.entityType, c.entityId)}
                  className={clsx(
                    'flex flex-col gap-1 rounded-md p-1',
                    current
                      ? 'cursor-default'
                      : 'hover:bg-gray-1 disabled:opacity-50 dark:hover:bg-dark-5'
                  )}
                >
                  <div className="relative">
                    <EventContentThumb
                      entityType={c.entityType}
                      image={c.image}
                      // Four to a row in the modal: a smaller card than Your hats'.
                      displayWidth={320}
                      hat={(other?.data ?? (current ? hat.data : undefined)) as EventDecorationData}
                    />
                    {badge && (
                      // Top right: the hat sits on the top-left corner.
                      <Badge
                        size="xs"
                        variant="filled"
                        color="dark"
                        className="pointer-events-none absolute right-1 top-1"
                        data-testid="placeable-type"
                      >
                        {badge}
                      </Badge>
                    )}
                  </div>
                  {c.title && (
                    <Text size="xs" fw={600} lineClamp={1}>
                      {c.title}
                    </Text>
                  )}
                  {(current || other) && (
                    <Text size="xs" c="dimmed" lineClamp={1}>
                      {current ? 'Wearing this hat now' : `Swaps off ${other?.name}`}
                    </Text>
                  )}
                </UnstyledButton>
              );
            })}
          </SimpleGrid>
        )}
        {list?.hasNextPage && (
          <Center>
            <Button
              variant="subtle"
              size="sm"
              loading={list.isFetchingNextPage}
              onClick={() => list.fetchNextPage()}
            >
              Show more
            </Button>
          </Center>
        )}
      </Stack>
    </Modal>
  );
}
