import {
  ActionIcon,
  Button,
  Card,
  Center,
  Group,
  HoverCard,
  Skeleton,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { IconHierarchy, IconPlus, IconSettings } from '@tabler/icons-react';
import clsx from 'clsx';
import dynamic from 'next/dynamic';
import { useState } from 'react';
import { AspectRatioImageCard } from '~/components/CardTemplates/AspectRatioImageCard';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import { RemixGalleryManageModal } from '~/components/RemixGallery/RemixGalleryManageModal';
import { RemixGallerySubmitModal } from '~/components/RemixGallery/RemixGallerySubmitModal';
import {
  dedupeGalleryItems,
  galleryDialogImages,
  trimToWholeRows,
  type RemixGalleryItem,
} from '~/components/RemixGallery/remix-gallery.utils';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { Currency } from '~/shared/utils/prisma/enums';
import { REMIX_GALLERY_ROW_WIDTH } from '~/shared/utils/remix-gallery';
import { trpc } from '~/utils/trpc';

// Loaded with the hover, not with the page. The creator card drags in profile
// cosmetics, live metrics and edge media, and this gallery renders on image
// detail pages whether or not anyone hovers an entry.
const SmartCreatorCard = dynamic(() =>
  import('~/components/CreatorCard/CreatorCard').then((m) => m.SmartCreatorCard)
);

/** Matches the sticker hover card, so the two read as the same object. */
const HOVER_CARD_WIDTH = 400;

/**
 * Who submitted this entry, on hover.
 *
 * The gallery is a marketing surface for the submitter as much as a decoration
 * for the owner — their name and shop reach everyone who looks at someone
 * else's image — so this carries the creator card's actions rather than the
 * sticker card's name-only treatment.
 *
 * Nothing is fetched per entry. `CreatorCardSimple` runs its own
 * `user.getCreator` query on mount, un-gated, so a card mounted per grid cell
 * would be one request per entry for the many nobody hovers. Rendering the
 * contents only once `opened` is what holds that to one request per hover —
 * Mantine would not mount the dropdown early either, but resting the property
 * on a library default leaves it invisible here and silently broken if the
 * default ever moves.
 */
function GalleryEntryHoverCard({
  item,
  children,
}: {
  item: RemixGalleryItem;
  children: React.ReactElement;
}) {
  const [opened, setOpened] = useState(false);

  return (
    <HoverCard
      width={HOVER_CARD_WIDTH}
      shadow="sm"
      withArrow
      withinPortal
      openDelay={300}
      position="bottom"
      offset={4}
      onOpen={() => setOpened(true)}
    >
      <HoverCard.Target>{children}</HoverCard.Target>
      {/* The creator card carries its own padding edge to edge, and its border
          is dropped rather than the dropdown's so there is one outline. */}
      <HoverCard.Dropdown p={0}>
        {opened ? (
          // The submitted image's owner IS the submitter: the mutation refuses
          // anything but your own image, so these cannot drift. `placerId` is
          // the fallback because the card only needs an id to fetch the rest.
          <SmartCreatorCard
            user={item.image.user ?? { id: item.placerId }}
            withActions
            withBorder={false}
          />
        ) : (
          <div className="p-3">
            <Skeleton height={92} radius="md" />
          </div>
        )}
      </HoverCard.Dropdown>
    </HoverCard>
  );
}

/**
 * The remix gallery, in the image-detail sidebar above generation data.
 *
 * Renders when the gallery is open **or** when it still holds entries. An owner
 * who stops accepting submissions keeps showing what they were already paid
 * for; only a gallery that is both closed and empty disappears entirely, so
 * content that never opted in shows nothing at all.
 */
export function RemixGalleryCard({ imageId }: { imageId: number }) {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const enabled = !!features.remixGallery;
  // Gallery entries are other people's images, so the viewer's own browsing
  // level has to travel with the request. It is also what resolves their
  // content addons server-side, so omitting it silently disables `disableMinor`
  // and their blocked-tag list as well as the level filter itself.
  const browsingLevel = useBrowsingLevelDebounced();

  const { data: visibility } = trpc.placement.getRemixGalleryVisibility.useQuery(
    { imageId },
    { enabled }
  );

  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    trpc.placement.getRemixGallery.useInfiniteQuery(
      { imageId, browsingLevel },
      {
        enabled: enabled && !!visibility?.render,
        getNextPageParam: (lastPage) => lastPage.nextCursor,
      }
    );

  if (!enabled || !visibility?.render) return null;

  const items: RemixGalleryItem[] = dedupeGalleryItems(
    data?.pages.flatMap((page) => page.items) ?? []
  );
  // Trimming only applies while more entries are waiting. On the last page the
  // remainder is everything that is left, and dropping it would make entries
  // the owner was paid for permanently unreachable.
  const shown = hasNextPage ? trimToWholeRows(items) : items;
  const isOwner = currentUser?.id === visibility.ownerId;
  // Server-side, and zero for anyone who is not the owner.
  const pendingCount = visibility.pendingCount ?? 0;

  return (
    <Card className="flex flex-col gap-3 rounded-xl">
      <Group justify="space-between" wrap="nowrap">
        <Text className="flex items-center gap-2 text-xl font-semibold">
          <IconHierarchy />
          <span>Remix gallery</span>
          <InfoPopover size="xs" iconProps={{ size: 14 }} width={340}>
            <Text size="sm" maw={320} style={{ whiteSpace: 'normal' }}>
              Creators can charge to feature other people&apos;s remixes here. The creator decides
              what belongs in their gallery and reviews every submission, so anything off-topic gets
              declined.
            </Text>
          </InfoPopover>
        </Text>
        {isOwner &&
          (pendingCount > 0 ? (
            // A gear icon does not say "two people are waiting on you". The
            // count was already reachable only by opening the modal, which is
            // the one place you would not look to find out you needed to.
            <Button
              size="compact-sm"
              variant="light"
              color="yellow"
              leftSection={<IconSettings size={16} />}
              onClick={() =>
                dialogStore.trigger({ component: RemixGalleryManageModal, props: { imageId } })
              }
            >
              {pendingCount} waiting
            </Button>
          ) : (
            <Tooltip label="Manage your gallery">
              <ActionIcon
                variant="subtle"
                onClick={() =>
                  dialogStore.trigger({ component: RemixGalleryManageModal, props: { imageId } })
                }
              >
                <IconSettings size={18} />
              </ActionIcon>
            </Tooltip>
          ))}
      </Group>

      {isLoading ? (
        // A skeleton row rather than a spinner: it occupies the shape the
        // entries will take, so the card does not resize under the reader when
        // they arrive. One row, because the common gallery is small and two
        // would overstate what is usually coming.
        <div className="grid grid-cols-4 gap-3">
          {Array.from({ length: REMIX_GALLERY_ROW_WIDTH }).map((_, index) => (
            <Skeleton key={index} className="aspect-square w-full rounded-md" />
          ))}
        </div>
      ) : shown.length ? (
        <div className="grid grid-cols-4 gap-3">
          {shown.map((item) => (
            <GalleryEntryHoverCard key={item.placementId} item={item}>
              {/* A wrapper because `AspectRatioImageCard` does not forward a
                  ref, and `HoverCard.Target` needs one on its child. */}
              <div>
                <AspectRatioImageCard
                  aspectRatio="square"
                  image={item.image}
                  className={clsx(item.pinned && 'ring-2 ring-yellow-5')}
                  routedDialog={{
                    name: 'imageDetail',
                    // Handing the dialog a set is what makes next/previous
                    // browse the gallery instead of the feed behind it.
                    state: {
                      imageId: item.image.id,
                      images: galleryDialogImages(item.image.id, shown),
                    },
                  }}
                />
              </div>
            </GalleryEntryHoverCard>
          ))}
        </div>
      ) : (
        // Built on a square the same size as a gallery entry, so a card that
        // fills later does not resize under someone scrolling a feed of image
        // pages — empty is now the common state, so this is the shape most
        // people see. The pitch sits beside it because an empty grid explains
        // nothing, and most readers have never seen a remix gallery.
        <Group gap="sm" wrap="nowrap" align="center">
          {/* An unanimated `Skeleton` is the backdrop rather than a colour of our
              own: it is the same grey the loading row uses, by construction, so
              the two states cannot drift apart when the palette moves. */}
          <div className="relative aspect-square w-1/4 shrink-0">
            <Skeleton animate={false} className="absolute inset-0 size-full rounded-md" />
            <Center className="absolute inset-0">
              <ThemeIcon size={38} radius="xl" variant="light">
                <IconHierarchy size={20} />
              </ThemeIcon>
            </Center>
          </div>
          {/* Two levels: what this is, then what to do about it. One flat
              paragraph made the pitch read as fine print. */}
          <Stack gap={4}>
            <Text size="sm" fw={600}>
              {isOwner
                ? 'Your gallery is open'
                : visibility.open
                ? 'Get your remix seen here'
                : 'Not accepting remixes'}
            </Text>
            {/* Gated exactly as the submit button is. On `open` alone it told
                the owner to be the first to add theirs, next to no button,
                since they are the one person who cannot. */}
            {isOwner ? (
              <Text size="xs" c="dimmed">
                Other creators can pay to feature their remixes on this image, and everyone who
                views it sees them. You approve each one.
              </Text>
            ) : visibility.open ? (
              // Says what a remix *is* before asking for one. Most readers have
              // never seen a gallery, and "submit yours" means nothing if you do
              // not know what would count — the examples are the spark, and the
              // first line is the reason to bother.
              <>
                <Text size="xs" c="dimmed">
                  Everyone who views this image sees this gallery. Make it yours and get seen
                  alongside it.
                </Text>
                <Text size="xs" c="dimmed">
                  Iterate on it, restyle it, edit it into something new, or turn it into a video —
                  then submit yours.
                </Text>
              </>
            ) : (
              <Text size="xs" c="dimmed">
                This creator has closed their gallery for now.
              </Text>
            )}
          </Stack>
        </Group>
      )}

      {hasNextPage && (
        <Button
          variant="subtle"
          radius="md"
          loading={isFetchingNextPage}
          onClick={() => fetchNextPage()}
        >
          Show more
        </Button>
      )}

      {visibility.open && !isOwner && (
        <Button
          variant="light"
          radius="md"
          leftSection={<IconPlus size={16} />}
          onClick={() =>
            dialogStore.trigger({
              component: RemixGallerySubmitModal,
              props: { hostImageId: imageId },
            })
          }
        >
          <Group gap={4} wrap="nowrap">
            <span>Submit your remix</span>
            {visibility.price != null && (
              <>
                <CurrencyIcon currency={Currency.BUZZ} size={14} />
                <span>{visibility.price}</span>
              </>
            )}
          </Group>
        </Button>
      )}
    </Card>
  );
}
