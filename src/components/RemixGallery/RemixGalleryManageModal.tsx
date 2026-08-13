import { closestCenter, DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { arrayMove, rectSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Divider,
  Group,
  Loader,
  Modal,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import {
  IconCheck,
  IconInbox,
  IconPin,
  IconPinnedOff,
  IconRotate,
  IconShieldCheck,
  IconTrash,
  IconWand,
  IconX,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { useEffect, useMemo, useState } from 'react';
import { AspectRatioImageCard } from '~/components/CardTemplates/AspectRatioImageCard';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import type { RemixGalleryItem } from '~/components/RemixGallery/remix-gallery.utils';
import { dedupeGalleryItems } from '~/components/RemixGallery/remix-gallery.utils';
import { SubmissionThumb } from '~/components/RemixGallery/SubmissionThumb';
import { VerifiedRemixBadge } from '~/components/RemixGallery/VerifiedRemixBadge';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { Currency } from '~/shared/utils/prisma/enums';
import { REMIX_GALLERY_MAX_PINNED, remixGalleryRemovableAt } from '~/shared/utils/remix-gallery';
import { daysFromNow, formatDateMin } from '~/utils/date-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const A_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * "2 hours ago" while it is still news, the stamp once it is history.
 *
 * A queue turns on how long something has been sitting in it, and
 * `formatDateMin` renders anything from today as a bare "9:10pm" — which is the
 * one case where the age is the thing you want and the label does not say it.
 * Same split, and the same reasoning, as the sticker hover card's `placedLabel`.
 */
const sentLabel = (sentAt: Date | string) => {
  const value = new Date(sentAt);
  return Date.now() - value.getTime() < A_DAY_MS ? daysFromNow(value) : formatDateMin(value);
};

/**
 * What an answer pays, rendered inside the button that gives that answer.
 *
 * The `+` is load-bearing: a bare Buzz amount on a button reads as its price,
 * which is the opposite of what happens here. Yellow because placements are paid
 * in purchasable Buzz — `PLACEMENT_SPEND_TYPES` excludes blue — so this is the
 * colour the submitter actually spent.
 */
function EarningsChip({ amount }: { amount: number }) {
  return (
    <Group gap={1} wrap="nowrap" className="shrink-0">
      <Text size="xs" fw={700} className="leading-none">
        +
      </Text>
      {/* Only the bolt takes the currency colour — the amount stays in the
          button's own text colour, so the pair reads as one label. */}
      <CurrencyIcon currency={Currency.BUZZ} type="yellow" size={12} />
      <Text size="xs" fw={700} className="leading-none">
        {amount}
      </Text>
    </Group>
  );
}

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

  // The card has already run this, so react-query serves it from cache.
  const { data: visibility } = trpc.placement.getRemixGalleryVisibility.useQuery({ imageId });
  const isOwner = !!currentUser && currentUser.id === visibility?.ownerId;

  /**
   * A moderator on someone else's gallery, which is a different modal.
   *
   * Two of the three sections are not merely disallowed for them, they are
   * unusable: `getPendingRemixGallerySubmissions` scopes to `ownerId = caller`,
   * so the review queue comes back empty and would render "Nothing waiting."
   * over a gallery that has two waiting; and `setRemixGalleryPins` scopes its
   * lookup the same way, so every drag would throw "not in this gallery".
   * Hiding them is honesty about reach, not a permission check — the server is
   * the permission check.
   */
  const moderating = isModerator && !isOwner;

  // Scoped server-side. Filtering the account-wide list here meant its limit
  // truncated before the filter ran, so a busy owner saw "nothing waiting" on
  // an image that had submissions.
  const {
    data: pendingPages,
    isLoading: pendingLoading,
    isError: pendingFailed,
    fetchNextPage: fetchMorePending,
    hasNextPage: hasMorePending,
    isFetchingNextPage: fetchingMorePending,
  } = trpc.placement.getPendingRemixGallerySubmissions.useInfiniteQuery(
    { hostImageId: imageId },
    { getNextPageParam: (lastPage) => lastPage.nextCursor }
  );
  const pending = useMemo(
    () => ({ items: pendingPages?.pages.flatMap((page) => page.items) ?? [] }),
    [pendingPages]
  );

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

  const actingOn = (placementId: number, action: 'approve' | 'decline' | 'remove') =>
    act.isPending && act.variables?.placementId === placementId && act.variables?.action === action;

  const setPins = trpc.placement.setRemixGalleryPins.useMutation({
    onSuccess: () => utils.placement.invalidate(),
    onError: (error) => {
      // Put the list back rather than leaving the UI showing an order the
      // server rejected.
      setPinnedIds(items.filter((item) => item.pinned).map((item) => item.placementId));
      showErrorNotification({ title: "Couldn't save that order", error: new Error(error.message) });
    },
  });

  const forThisImage = (pending?.items ?? []).filter((row) => row.targetId === imageId);
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
    <Modal
      {...dialog}
      title={moderating ? 'Moderate this remix gallery' : 'Manage your remix gallery'}
      size="lg"
    >
      <Stack gap="md">
        {moderating && (
          // Not decoration. The same button in an owner's hands returns the
          // submitter's Buzz and in a moderator's keeps it, and the row records
          // which happened. Someone holding both roles should not have to
          // remember which gallery they are looking at.
          <Alert color="red" icon={<IconShieldCheck size={18} />} p="xs">
            <Text size="sm" fw={600}>
              You are moderating {visibility?.ownerUsername ?? 'another creator'}&apos;s gallery
            </Text>
            <Text size="xs" mt={2}>
              You can take entries down. Removing one here is a moderator takedown — the submitter
              is not refunded, and the removal is recorded against you rather than the creator.
              Approving, declining and pinning stay with the creator.
            </Text>
          </Alert>
        )}

        {!moderating && (
          <div>
            <SectionDivider
              icon={IconInbox}
              label="Waiting for review"
              badge={
                forThisImage.length ? (
                  <Badge size="sm" variant="light" color="yellow">
                    {hasMorePending ? `${forThisImage.length}+` : forThisImage.length}
                  </Badge>
                ) : null
              }
            />
            {pendingLoading ? (
              <Group justify="center" py="md">
                <Loader size="sm" />
              </Group>
            ) : pendingFailed ? (
              // No pages means `hasMorePending` is false too, so without this the
              // branch below would say "nothing waiting" over a queue that failed
              // to load.
              <Text size="sm" c="red" mt="sm">
                Couldn&rsquo;t load the review queue. Refresh to try again.
              </Text>
            ) : forThisImage.length || hasMorePending ? (
              <Stack gap="xs" mt="sm">
                {/* A page can come back empty with a cursor still set — every
                    submission on it had its image deleted, unpublished or still
                    ingesting. Saying "nothing waiting" here would hide the ones
                    behind it, which is the bug the paging exists to end. */}
                {!forThisImage.length && (
                  <Text size="sm" c="dimmed">
                    Nothing on this page can be shown. There are more waiting.
                  </Text>
                )}
                {forThisImage.map((row) => (
                  <Card key={row.id} withBorder p="xs" radius="md">
                    <Group justify="space-between" wrap="nowrap" align="center">
                      <Group gap="sm" wrap="nowrap" className="min-w-0">
                        {row.image && <SubmissionThumb image={row.image} />}
                        {/* `align="flex-start"` because a Stack stretches its
                            children: without it the badge and the username row
                            each spanned the full card width, which also dragged
                            the badge's hover card off to the far edge. */}
                        <Stack gap={6} align="flex-start" className="min-w-0">
                          {/* What arrived and when, above who sent it — the queue
                              is read top-down and the age is what decides which
                              row to answer first. */}
                          <Group gap={6} wrap="nowrap" className="min-w-0">
                            <IconWand size={14} className="shrink-0 text-yellow-6" />
                            <Text size="xs" c="dimmed" className="truncate">
                              Remix submitted {sentLabel(row.createdAt)}
                            </Text>
                          </Group>
                          {row.placer ? (
                            <UserAvatar user={row.placer} withUsername size="sm" linkToProfile />
                          ) : (
                            <Text size="sm" fw={500}>
                              Someone
                            </Text>
                          )}
                          {/* Its own line, and shown only when we resolved it
                              ourselves. There is deliberately no counterpart for
                              its absence: an off-site remix can never earn this,
                              and marking those would turn a missing signal into a
                              verdict. */}
                          {row.data.derivedFromHost && <VerifiedRemixBadge />}
                        </Stack>
                      </Group>
                      {/* Stacked, and the same width, so the pair reads as one
                        decision with two answers rather than a row of buttons.
                        Keyed to the row and the action — bare `act.isPending`
                        spun every button in the queue on any one click. */}
                      {/* Each answer carries what it pays, so the owner never has
                          to know that declining still earns a fee — the numbers
                          come from the server, computed with the settlement's own
                          helpers against this row's amount. */}
                      <Stack gap={6} className="w-36 shrink-0">
                        <Button
                          size="compact-sm"
                          fullWidth
                          classNames={{ label: 'w-full justify-between gap-2' }}
                          leftSection={<IconCheck size={14} />}
                          rightSection={<EarningsChip amount={row.earnings.approve} />}
                          loading={actingOn(row.id, 'approve')}
                          onClick={() => act.mutate({ placementId: row.id, action: 'approve' })}
                        >
                          Approve
                        </Button>
                        <Button
                          size="compact-sm"
                          fullWidth
                          variant="default"
                          classNames={{ label: 'w-full justify-between gap-2' }}
                          leftSection={<IconX size={14} />}
                          rightSection={<EarningsChip amount={row.earnings.decline} />}
                          loading={actingOn(row.id, 'decline')}
                          onClick={() => act.mutate({ placementId: row.id, action: 'decline' })}
                        >
                          Decline
                        </Button>
                      </Stack>
                    </Group>
                  </Card>
                ))}
                {hasMorePending && (
                  <Button
                    variant="default"
                    size="xs"
                    loading={fetchingMorePending}
                    onClick={() => fetchMorePending()}
                  >
                    Load more
                  </Button>
                )}
              </Stack>
            ) : (
              <Text size="sm" c="dimmed" mt="sm">
                Nothing waiting.
              </Text>
            )}
          </div>
        )}

        {!moderating && (
          <div>
            <SectionDivider
              icon={IconPin}
              label="Pinned"
              badge={
                <Badge size="sm" variant="light">
                  {pinnedIds.length}/{REMIX_GALLERY_MAX_PINNED}
                </Badge>
              }
            />
            <Text size="xs" c="dimmed" mt="sm">
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
        )}

        <div>
          <SectionDivider icon={IconRotate} label="In the rotation" />
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
                    {/* Pinning is the creator's curation, and `setRemixGalleryPins`
                        scopes its lookup to the caller as owner — a moderator
                        pressing this would get "not in this gallery" on every
                        press. */}
                    {!moderating && (
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
                    )}
                    <RemoveEntryButton
                      item={item}
                      isModerator={isModerator}
                      pending={actingOn(item.placementId, 'remove')}
                      onRemove={() => {
                        const remove = () =>
                          act.mutate({ placementId: item.placementId, action: 'remove' });
                        // Confirmed for a moderator and not for an owner, because
                        // the two are different acts: an owner removal returns the
                        // submitter's Buzz, a moderator takedown keeps it. Nothing
                        // undoes that, and the row records who did it.
                        if (!moderating) return remove();
                        openConfirmModal({
                          title: 'Take this entry down',
                          children: (
                            <Text size="sm">
                              This removes the remix from{' '}
                              {visibility?.ownerUsername ?? 'the creator'}&apos;s gallery for
                              everyone. The submitter is not refunded, and the takedown is recorded
                              against you.
                            </Text>
                          ),
                          labels: { confirm: 'Take down', cancel: 'Cancel' },
                          confirmProps: { color: 'red' },
                          onConfirm: remove,
                        });
                      }}
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

/**
 * A section heading that is the rule itself rather than text sitting above one.
 *
 * The three sections are different kinds of thing — a queue, a fixed order, and
 * everything else — and at a glance they previously read as one long list with
 * bold words in it.
 */
function SectionDivider({
  icon: Icon,
  label,
  badge,
}: {
  icon: typeof IconInbox;
  label: string;
  badge?: React.ReactNode;
}) {
  return (
    <Divider
      labelPosition="left"
      label={
        <Group gap={6} wrap="nowrap">
          <Icon size={15} />
          <Text fw={600} size="sm">
            {label}
          </Text>
          {badge}
        </Group>
      }
    />
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
