import {
  ActionIcon,
  Anchor,
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
import {
  IconClock,
  IconHierarchy,
  IconPlus,
  IconSettings,
  IconShieldCheck,
} from '@tabler/icons-react';
import clsx from 'clsx';
import dynamic from 'next/dynamic';
import { useState } from 'react';
import { AspectRatioImageCard } from '~/components/CardTemplates/AspectRatioImageCard';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { RemixGalleryExplainer } from '~/components/RemixGallery/RemixGalleryExplainer';
import { RemixGalleryManageModal } from '~/components/RemixGallery/RemixGalleryManageModal';
import { RemixGallerySubmitModal } from '~/components/RemixGallery/RemixGallerySubmitModal';
import { QueueThumb } from '~/components/RemixGallery/SubmissionPair';
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
import { formatDate } from '~/utils/date-helpers';
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
        {/* Says why this popped. Without it the dropdown is a bare profile card
            appearing over an image, with nothing tying it to the gallery it
            came from. Same treatment as the sticker hover card's header, down
            to the yellow on the icon, so the two read as one object.

            One sentence rather than a name on the left and a date pushed right:
            split across the width the date read as detached from the line it
            belongs to. It repeats the name the creator card below shows, which
            is deliberate — the sentence is the thing being read, and half of it
            is not a sentence.

            The date is `resolvedAt`, the moment the owner approved it and it
            started appearing. "Remixed by X on <date>" carries that without
            claiming it is a submission date, which is what "submitted on"
            would have got wrong. */}
        <Group gap={6} px="sm" py={6} wrap="nowrap">
          <IconHierarchy size={14} className="shrink-0 text-yellow-6" />
          <Text size="xs" c="dimmed" className="min-w-0 truncate">
            Remixed by{' '}
            <Text span fw={600} inherit>
              {item.image.user?.username ?? 'someone'}
            </Text>
            {item.resolvedAt ? ` on ${formatDate(item.resolvedAt)}` : ''}
          </Text>
        </Group>
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
  const isModerator = currentUser?.isModerator ?? false;
  // Server-side, and zero for anyone who is not the owner.
  const pendingCount = visibility.pendingCount ?? 0;
  // Server-side, and empty for the owner and for signed-out viewers.
  const viewerPending = visibility.viewerPending ?? [];

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
        {/* A moderator gets in on any image so they can take an entry down.
            Not the same button: `pendingCount` is computed owner-only, so a
            count here would read "0 waiting" over a gallery with two, and the
            queue behind it is owner-scoped anyway. Theirs says what it is. */}
        {!isOwner && isModerator && (
          <Tooltip label="Moderate this gallery">
            <ActionIcon
              variant="subtle"
              color="red"
              onClick={() =>
                dialogStore.trigger({ component: RemixGalleryManageModal, props: { imageId } })
              }
            >
              <IconShieldCheck size={18} />
            </ActionIcon>
          </Tooltip>
        )}
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

      <RemixGalleryExplainer />

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

      {/* Answers "did that work?". Submitting charged Buzz and changed nothing
          on the image it was sent to, so the submitter's only evidence was the
          notification they get when the owner eventually decides. Shown to the
          submitter alone — the owner has the review queue, and everyone else has
          no business seeing what is waiting. */}
      {viewerPending.length > 0 && (
        <Stack gap={6} className="rounded-md bg-gray-1 p-2 dark:bg-dark-6">
          <Group gap={6} wrap="nowrap">
            <IconClock size={14} className="shrink-0 text-yellow-6" />
            <Text size="xs" fw={600}>
              {viewerPending.length === 1
                ? 'Your remix is pending review'
                : `${viewerPending.length} of your remixes are pending review`}
            </Text>
          </Group>
          <Group gap={6} wrap="nowrap" className="overflow-x-auto">
            {viewerPending.map((pending) => (
              <QueueThumb
                key={pending.placementId}
                image={pending.image}
                label="Open this remix in a new tab"
                missing="This image is no longer available to preview"
              />
            ))}
          </Group>
          {/* No username: it wrapped this to two lines, and it was saying what
              the page already does — this card sits on that creator's own image.
              The link carries `tab=sent` because the page defaults to `received`,
              which is the queue of submissions TO you: without it "withdraw"
              landed on a tab that does not contain the thing being withdrawn. */}
          <Text size="xs" c="dimmed">
            Waiting on the creator. You can{' '}
            <Anchor href="/user/remix-submissions?tab=sent" size="xs">
              {viewerPending.length === 1 ? 'withdraw it' : 'withdraw them'}
            </Anchor>{' '}
            until they decide.
          </Text>
        </Stack>
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

      {/* Wrapped rather than hidden. A signed-out visitor could open the modal
          and be told the gallery was closed — it is open, they are signed out,
          and nothing said so. */}
      {visibility.open && !isOwner && (
        <LoginRedirect reason="perform-action">
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
        </LoginRedirect>
      )}

      {/* Derived from the owner's actual share rather than asserting one. The
          split is operator-tunable at runtime, so "all proceeds" compiled into
          a string is a claim about money that can stop being true without
          anyone touching this file. It says "all" only when it is all. */}
      {visibility.open && !isOwner && visibility.ownerUsername && (
        <Text size="xs" ta="center" c="dimmed" mt={-4}>
          {visibility.ownerShare >= 1
            ? `All proceeds go to @${visibility.ownerUsername}`
            : `${Math.round(visibility.ownerShare * 100)}% of what you pay goes to @${
                visibility.ownerUsername
              }`}
        </Text>
      )}
    </Card>
  );
}
