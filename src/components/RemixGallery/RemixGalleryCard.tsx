import { ActionIcon, Button, Card, Group, Loader, Text, Tooltip } from '@mantine/core';
import { IconHierarchy, IconPlus, IconSettings } from '@tabler/icons-react';
import clsx from 'clsx';
import { AspectRatioImageCard } from '~/components/CardTemplates/AspectRatioImageCard';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import { RemixGalleryManageModal } from '~/components/RemixGallery/RemixGalleryManageModal';
import { RemixGallerySubmitModal } from '~/components/RemixGallery/RemixGallerySubmitModal';
import {
  galleryDialogImages,
  trimToWholeRows,
  type RemixGalleryItem,
} from '~/components/RemixGallery/remix-gallery.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { Currency } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';

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

  const { data: visibility } = trpc.placement.getRemixGalleryVisibility.useQuery(
    { imageId },
    { enabled }
  );

  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    trpc.placement.getRemixGallery.useInfiniteQuery(
      { imageId },
      {
        enabled: enabled && !!visibility?.render,
        getNextPageParam: (lastPage) => lastPage.nextCursor,
      }
    );

  if (!enabled || !visibility?.render) return null;

  const items: RemixGalleryItem[] = data?.pages.flatMap((page) => page.items) ?? [];
  // Trimming only applies while more entries are waiting. On the last page the
  // remainder is everything that is left, and dropping it would make entries
  // the owner was paid for permanently unreachable.
  const shown = hasNextPage ? trimToWholeRows(items) : items;
  const isOwner = currentUser?.id === visibility.ownerId;

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
        {isOwner && (
          <Tooltip label="Manage your gallery">
            <ActionIcon
              variant="subtle"
              onClick={() =>
                dialogStore.trigger({
                  component: RemixGalleryManageModal,
                  props: { imageId },
                })
              }
            >
              <IconSettings size={18} />
            </ActionIcon>
          </Tooltip>
        )}
      </Group>

      {isLoading ? (
        <Group justify="center" py="md">
          <Loader size="sm" />
        </Group>
      ) : shown.length ? (
        <div className="grid grid-cols-4 gap-3">
          {shown.map((item) => (
            <AspectRatioImageCard
              key={item.placementId}
              aspectRatio="square"
              image={item.image}
              className={clsx(item.pinned && 'ring-2 ring-yellow-5')}
              routedDialog={{
                name: 'imageDetail',
                // Handing the dialog a set is what makes next/previous browse
                // the gallery instead of the feed behind it.
                state: {
                  imageId: item.image.id,
                  images: galleryDialogImages(item.image.id, shown),
                },
              }}
            />
          ))}
        </div>
      ) : (
        <Text size="sm" c="dimmed">
          No remixes here yet. {visibility.open && 'Be the first to add yours.'}
        </Text>
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
