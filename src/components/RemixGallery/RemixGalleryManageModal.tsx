import { closestCenter, DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { arrayMove, rectSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Divider,
  Group,
  Loader,
  Modal,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { IconCheck, IconPin, IconPinnedOff, IconTrash, IconX } from '@tabler/icons-react';
import clsx from 'clsx';
import { useEffect, useMemo, useState } from 'react';
import { AspectRatioImageCard } from '~/components/CardTemplates/AspectRatioImageCard';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import type { RemixGalleryItem } from '~/components/RemixGallery/remix-gallery.utils';
import { dedupeGalleryItems } from '~/components/RemixGallery/remix-gallery.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { Currency } from '~/shared/utils/prisma/enums';
import { REMIX_GALLERY_MAX_PINNED, remixGalleryRemovableAt } from '~/shared/utils/remix-gallery';
import { daysFromNow, formatDateMin } from '~/utils/date-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * The owner's control over one gallery: review what is waiting, and pin or
 * remove what is live.
 *
 * A modal rather than controls on the card itself — the card is a reading
 * surface in a narrow sidebar, and approve/decline/drag do not fit beside a
 * 4-across grid without clipping.
 */
export function RemixGalleryManageModal({ imageId }: { imageId: number }) {
  const dialog = useDialogContext();
  const utils = trpc.useUtils();
  const currentUser = useCurrentUser();
  const isModerator = currentUser?.isModerator ?? false;

  // Scoped server-side. Filtering the account-wide list here meant its limit
  // truncated before the filter ran, so a busy owner saw "nothing waiting" on
  // an image that had submissions.
  const { data: pending, isLoading: pendingLoading } =
    trpc.placement.getPendingRemixGallerySubmissions.useQuery({ hostImageId: imageId });

  // **Deliberately does not send the viewer's browsing level**, unlike the
  // gallery card. This is the owner managing what sits on their own image, so a
  // browsing preference must not decide which entries they are allowed to take
  // down. Sending it hid mature entries from the owner entirely — and because
  // the pinned set below is re-seeded from these rows and committed as a whole
  // set on the next drag, a hidden pin was silently unpinned. A display filter
  // turning into a write is the shape to watch for here.
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    trpc.placement.getRemixGallery.useInfiniteQuery(
      { imageId },
      { getNextPageParam: (lastPage) => lastPage.nextCursor }
    );

  const items: RemixGalleryItem[] = useMemo(
    () => dedupeGalleryItems(data?.pages.flatMap((page) => page.items) ?? []),
    [data]
  );

  // Local order for the pinned row, committed on drop. Seeded from the server
  // and re-seeded whenever it changes, so a pin made elsewhere is not silently
  // overwritten by a stale local list.
  const [pinnedIds, setPinnedIds] = useState<number[]>([]);
  useEffect(() => {
    setPinnedIds(items.filter((item) => item.pinned).map((item) => item.placementId));
  }, [items]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const act = trpc.placement.actOnRemixGallerySubmission.useMutation({
    onSuccess: () => utils.placement.invalidate(),
    onError: (error) =>
      showErrorNotification({ title: "Couldn't do that", error: new Error(error.message) }),
  });

  const setPins = trpc.placement.setRemixGalleryPins.useMutation({
    onSuccess: () => utils.placement.invalidate(),
    onError: (error) => {
      // Put the list back rather than leaving the UI showing an order the
      // server rejected.
      setPinnedIds(items.filter((item) => item.pinned).map((item) => item.placementId));
      showErrorNotification({ title: "Couldn't save that order", error: new Error(error.message) });
    },
  });

  const forThisImage = (pending ?? []).filter((row) => row.targetId === imageId);
  const byId = new Map(items.map((item) => [item.placementId, item]));
  const pinnedItems = pinnedIds.map((id) => byId.get(id)).filter((x): x is RemixGalleryItem => !!x);
  const unpinned = items.filter((item) => !pinnedIds.includes(item.placementId));
  const atPinCap = pinnedIds.length >= REMIX_GALLERY_MAX_PINNED;

  const commitPins = (ids: number[]) => {
    setPinnedIds(ids);
    setPins.mutate({ hostImageId: imageId, placementIds: ids });
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const oldIndex = pinnedIds.indexOf(Number(active.id));
    const newIndex = pinnedIds.indexOf(Number(over.id));
    if (oldIndex === -1 || newIndex === -1) return;
    commitPins(arrayMove(pinnedIds, oldIndex, newIndex));
  };

  return (
    <Modal {...dialog} title="Manage your remix gallery" size="lg">
      <Stack gap="md">
        <div>
          <Text fw={600}>Waiting for review</Text>
          {pendingLoading ? (
            <Group justify="center" py="md">
              <Loader size="sm" />
            </Group>
          ) : forThisImage.length ? (
            <Stack gap="xs" mt="xs">
              {forThisImage.map((row) => (
                <Group key={row.id} justify="space-between" wrap="nowrap">
                  <Group gap="xs" wrap="nowrap">
                    {row.image && (
                      <div className="w-16">
                        <AspectRatioImageCard aspectRatio="square" image={row.image} />
                      </div>
                    )}
                    <Stack gap={0}>
                      <Text size="sm">{row.placer?.username ?? 'Someone'}</Text>
                      <Group gap={4}>
                        <CurrencyIcon currency={Currency.BUZZ} size={12} />
                        <Text size="xs" c="dimmed">
                          {row.amount}
                        </Text>
                      </Group>
                    </Stack>
                  </Group>
                  <Group gap="xs" wrap="nowrap">
                    <Button
                      size="compact-sm"
                      leftSection={<IconCheck size={14} />}
                      loading={act.isPending}
                      onClick={() => act.mutate({ placementId: row.id, action: 'approve' })}
                    >
                      Approve
                    </Button>
                    <Button
                      size="compact-sm"
                      variant="default"
                      leftSection={<IconX size={14} />}
                      loading={act.isPending}
                      onClick={() => act.mutate({ placementId: row.id, action: 'decline' })}
                    >
                      Decline
                    </Button>
                  </Group>
                </Group>
              ))}
            </Stack>
          ) : (
            <Text size="sm" c="dimmed" mt="xs">
              Nothing waiting.
            </Text>
          )}
        </div>

        <Divider />

        <div>
          <Group gap={6}>
            <Text fw={600}>Pinned</Text>
            <Badge size="sm" variant="light">
              {pinnedIds.length}/{REMIX_GALLERY_MAX_PINNED}
            </Badge>
          </Group>
          <Text size="xs" c="dimmed">
            Pinned remixes always show first, in the order you set here. Everything else rotates.
          </Text>

          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={pinnedIds} strategy={rectSortingStrategy}>
              <div className="mt-2 grid grid-cols-4 gap-3">
                {pinnedItems.map((item) => (
                  <SortablePin
                    key={item.placementId}
                    item={item}
                    onUnpin={() => commitPins(pinnedIds.filter((id) => id !== item.placementId))}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
          {!pinnedItems.length && (
            <Text size="sm" c="dimmed" mt="xs">
              Nothing pinned.
            </Text>
          )}
        </div>

        <Divider />

        <div>
          <Text fw={600}>In the rotation</Text>
          {atPinCap && (
            <Alert color="gray" p="xs" mt="xs">
              <Text size="xs">
                You&apos;ve pinned the maximum of {REMIX_GALLERY_MAX_PINNED}. Unpin one to pin
                something else.
              </Text>
            </Alert>
          )}
          {isLoading ? (
            <Group justify="center" py="md">
              <Loader size="sm" />
            </Group>
          ) : unpinned.length ? (
            <div className="mt-2 grid grid-cols-4 gap-3">
              {unpinned.map((item) => (
                <div key={item.placementId} className="relative">
                  <AspectRatioImageCard aspectRatio="square" image={item.image} />
                  <Group gap={4} className="absolute right-1 top-1">
                    <Tooltip
                      label={
                        atPinCap
                          ? `Unpin one first — the limit is ${REMIX_GALLERY_MAX_PINNED}`
                          : 'Pin to the top'
                      }
                    >
                      <ActionIcon
                        size="sm"
                        variant="filled"
                        color="dark"
                        disabled={atPinCap}
                        onClick={() => commitPins([...pinnedIds, item.placementId])}
                      >
                        <IconPin size={14} />
                      </ActionIcon>
                    </Tooltip>
                    <RemoveEntryButton
                      item={item}
                      isModerator={isModerator}
                      pending={act.isPending && act.variables?.placementId === item.placementId}
                      onRemove={() =>
                        act.mutate({ placementId: item.placementId, action: 'remove' })
                      }
                    />
                  </Group>
                </div>
              ))}
            </div>
          ) : (
            <Text size="sm" c="dimmed" mt="xs">
              Nothing live in this gallery yet.
            </Text>
          )}

          {/* Without this an owner past the first page cannot remove or pin
              anything below it — the entries are simply not in the list. */}
          {hasNextPage && (
            <Button
              variant="subtle"
              size="compact-sm"
              mt="xs"
              loading={isFetchingNextPage}
              onClick={() => fetchNextPage()}
            >
              Show more
            </Button>
          )}
        </div>
      </Stack>
    </Modal>
  );
}

/**
 * Remove, refused for a week after approval.
 *
 * Approval settles the money, so an owner who could approve and immediately
 * remove would keep the Buzz and give the submitter nothing. The mutation is
 * what enforces that; this only explains it, which is why it fails **open** —
 * a missing `resolvedAt` shows an enabled button and lets the server rule,
 * rather than locking someone out on absent data.
 *
 * Moderators are exempt here because they are exempt on the mutation. Disabling
 * it for them would hide an action the server would allow, and a takedown is
 * the case that must not wait.
 */
function RemoveEntryButton({
  item,
  isModerator,
  pending,
  onRemove,
}: {
  item: RemixGalleryItem;
  isModerator: boolean;
  pending: boolean;
  onRemove: () => void;
}) {
  const removableAt = item.resolvedAt ? remixGalleryRemovableAt(item.resolvedAt) : null;
  const locked = !isModerator && !!removableAt && removableAt > new Date();

  return (
    <Tooltip
      withArrow
      multiline
      w={260}
      label={
        locked && removableAt
          ? // Both halves are deliberate: "5 days" answers how long, the stamp
            // answers when, and neither substitutes for the other on a wait
            // measured in days. Framed as the submitter's protection because
            // that is what it is — they paid to be here.
            `Someone paid to be featured here, so entries stay up for a week after you approve them. You can remove this in ${daysFromNow(
              removableAt,
              { withoutSuffix: true }
            )} — ${formatDateMin(removableAt)}.`
          : 'Remove from your gallery'
      }
    >
      <ActionIcon
        size="sm"
        variant="filled"
        color="red"
        loading={pending}
        // `data-disabled` rather than `disabled`: a disabled button fires no
        // pointer events, so Mantine's tooltip never opens — and the tooltip is
        // the entire point of disabling it. This keeps the disabled styling and
        // the explanation, with the click stopped below.
        data-disabled={locked || undefined}
        onClick={(event: React.MouseEvent) => {
          if (locked) {
            event.preventDefault();
            return;
          }
          onRemove();
        }}
      >
        <IconTrash size={14} />
      </ActionIcon>
    </Tooltip>
  );
}

function SortablePin({ item, onUnpin }: { item: RemixGalleryItem; onUnpin: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.placementId,
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={clsx('relative', isDragging && 'z-10 opacity-80')}
      {...attributes}
      {...listeners}
    >
      <AspectRatioImageCard aspectRatio="square" image={item.image} />
      <Tooltip label="Unpin">
        <ActionIcon
          size="sm"
          variant="filled"
          color="dark"
          className="absolute right-1 top-1"
          // The drag listeners sit on the wrapper, so a click here would also
          // start a drag without this.
          onPointerDown={(event: React.PointerEvent) => event.stopPropagation()}
          onClick={onUnpin}
        >
          <IconPinnedOff size={14} />
        </ActionIcon>
      </Tooltip>
    </div>
  );
}
