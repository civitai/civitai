import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  Stack,
  Tabs,
  Text,
} from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { IconCheck, IconX } from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { PlacementFreeBadge } from '~/components/Placement/PlacementFreeBadge';
import { PlacementFreeFilter } from '~/components/Placement/PlacementFreeFilter';
import { visibleQueueRows } from '~/components/Placement/free-filter';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { SubmissionPair } from '~/components/RemixGallery/SubmissionPair';
import { useWithheldHref } from '~/components/Placement/useWithheldHref';
import { Currency } from '~/shared/utils/prisma/enums';
import type { RouterOutput } from '~/types/router';
import { daysFromNow, formatDate } from '~/utils/date-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { REMIX_GALLERY_QUEUE_LIMIT } from '~/shared/utils/remix-gallery';
import { trpc } from '~/utils/trpc';

const TABS = ['received', 'sent'] as const;
type TabValue = (typeof TABS)[number];

const isTabValue = (value: unknown): value is TabValue => TABS.includes(value as TabValue);

const A_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * "2 hours ago" while it is still news, the date once it is history.
 *
 * Both queues turn on how long something has been sitting in them, and an
 * absolute date answers that worst in exactly the window where people care.
 * Same split the manage modal and the sticker hover card make.
 */
const agedLabel = (at: Date | string) => {
  const value = new Date(at);
  return Date.now() - value.getTime() < A_DAY_MS ? daysFromNow(value) : formatDate(value);
};

/**
 * Both directions of a remix gallery submission: what is waiting on your
 * images, and what you have sent to other people's.
 *
 * Received is the default because it is the only side with actions on it —
 * a submission sits pending until the owner rules on it, and expires if they
 * never do.
 */
export function RemixSubmissionQueue() {
  const router = useRouter();
  // The queue marks rows against this rather than filtering on it. A submission
  // hidden for being outside the owner's band still expires, and expiry costs
  // the submitter nothing and the owner their fee — so it has to be visible
  // enough to act on.
  const browsingLevel = useBrowsingLevelDebounced();
  const tab: TabValue = isTabValue(router.query.tab) ? router.query.tab : 'received';

  const setTab = (value: string | null) =>
    router.replace(
      { query: { ...router.query, tab: isTabValue(value) ? value : 'received' } },
      undefined,
      { shallow: true }
    );

  // Both run on mount rather than per-tab: the received count is shown on the
  // tab itself, so it has to be known while `sent` is the one on screen.
  const {
    data: received,
    isLoading: receivedLoading,
    isError: receivedFailed,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = trpc.placement.getPendingRemixGallerySubmissions.useInfiniteQuery(
    { browsingLevel },
    { getNextPageParam: (lastPage) => lastPage.nextCursor }
  );
  const { data: sent, isLoading: sentLoading } =
    trpc.placement.getMyRemixGallerySubmissions.useQuery({ browsingLevel });

  const receivedRows = received?.pages.flatMap((page) => page.items) ?? [];
  const waiting = receivedRows.length;

  return (
    <Tabs value={tab} onChange={setTab} keepMounted={false}>
      <Tabs.List>
        <Tabs.Tab
          value="received"
          rightSection={
            waiting || hasNextPage ? (
              // `circle` fixes the width to a one- or two-character disc,
              // so the "+" of a truncated count clips to "5…". A pill for
              // the wider label, the disc for the plain count.
              <Badge
                size="sm"
                variant="filled"
                circle={!hasNextPage}
                px={hasNextPage ? 6 : undefined}
              >
                {hasNextPage ? `${waiting}+` : waiting}
              </Badge>
            ) : null
          }
        >
          Received
        </Tabs.Tab>
        <Tabs.Tab value="sent">Sent</Tabs.Tab>
      </Tabs.List>

      <Tabs.Panel value="received" pt="md">
        <ReceivedTab
          rows={receivedRows}
          isLoading={receivedLoading}
          isError={receivedFailed}
          hasMore={!!hasNextPage}
          isFetchingMore={isFetchingNextPage}
          onLoadMore={() => fetchNextPage()}
        />
      </Tabs.Panel>

      <Tabs.Panel value="sent" pt="md">
        <SentTab rows={sent ?? []} isLoading={sentLoading} />
      </Tabs.Panel>
    </Tabs>
  );
}

type ReceivedRow = RouterOutput['placement']['getPendingRemixGallerySubmissions']['items'][number];

function ReceivedTab({
  rows,
  isLoading,
  isError,
  hasMore,
  isFetchingMore,
  onLoadMore,
}: {
  rows: ReceivedRow[];
  isLoading: boolean;
  isError: boolean;
  hasMore: boolean;
  isFetchingMore: boolean;
  onLoadMore: () => void;
}) {
  const utils = trpc.useUtils();
  const withheldHref = useWithheldHref();
  const [showFree, setShowFree] = useState(true);

  // Filtered here rather than in the parent so the tab's own badge keeps
  // counting everything waiting: hiding the free ones is a view of the queue,
  // not a statement about how much is in it.
  const visible = visibleQueueRows(rows, showFree);

  const act = trpc.placement.actOnRemixGallerySubmission.useMutation({
    onSuccess: (_result, variables) => {
      // Says what the row did, not what the ledger did. Approving pays the
      // owner and declining splits the escrow, but a settled status transition
      // is not a paid one — see the withdraw copy on the other tab.
      showSuccessNotification(
        variables.action === 'approve'
          ? { title: 'Approved', message: "It's in your gallery now." }
          : { title: 'Declined', message: "It won't appear in your gallery." }
      );
      utils.placement.invalidate();
    },
    // The server re-checks the submitted image's rating at approval, so this
    // legitimately refuses when that rating moved after it was sent. Show what
    // it said — a generic failure gives the owner nothing to act on.
    onError: (error) =>
      showErrorNotification({ title: "Couldn't do that", error: new Error(error.message) }),
  });

  const busyWith = (id: number, action: 'approve' | 'decline') =>
    act.isPending && act.variables?.placementId === id && act.variables?.action === action;

  if (isLoading)
    return (
      <Group justify="center" py="xl">
        <Loader />
      </Group>
    );

  // A failed read has no pages, so `hasMore` is false and the empty state below
  // would say "nothing is waiting" over a queue nobody could load. Said out loud
  // instead — the owner can retry; escrow they never hear about expires.
  if (isError)
    return (
      <Alert color="red">
        <Text size="sm">Couldn&rsquo;t load your review queue. Refresh to try again.</Text>
      </Alert>
    );

  // `&& !hasMore` is the whole point. A page whose rows were all dropped —
  // submissions whose image was deleted, unpublished or is still ingesting —
  // returns no items and a cursor. Returning the empty state here would put
  // "nothing is waiting" over a queue with entries behind it, which is the
  // failure this paging exists to end, moved one layer up.
  if (!rows.length && !hasMore)
    return (
      <Alert color="gray">
        <Text size="sm">Nothing is waiting for your review.</Text>
        <Text size="sm" c="dimmed" mt={4}>
          When someone submits a remix on one of your images — paid, or against the free slots you
          offer — it appears here for you to approve or decline. You choose whether to accept them
          at all, how many free ones you take, and what the paid ones cost, in{' '}
          <Anchor component={Link} href="/user/account">
            your account settings
          </Anchor>
          .
        </Text>
      </Alert>
    );

  return (
    <Stack gap="md">
      {rows.some((row) => row.free) && (
        <Group justify="flex-end">
          <PlacementFreeFilter show={showFree} onChange={setShowFree} noun="submissions" />
        </Group>
      )}

      {!rows.length && (
        <Text size="sm" c="dimmed">
          Nothing on this page can be shown — the images behind these submissions are gone or still
          processing. There are more waiting.
        </Text>
      )}

      {/* Said separately from the line above it, which is about rows the server
          dropped. An empty queue because the owner hid the free ones is their
          own doing, and telling them their images are gone would be false. */}
      {!!rows.length && !visible.length && (
        <Text size="sm" c="dimmed">
          Every submission waiting on you is a free one, and free ones are hidden.
        </Text>
      )}

      {visible.map((row) => (
        <Card key={row.id} withBorder>
          <Group justify="space-between" wrap="nowrap" align="flex-start">
            <Group gap="sm" wrap="nowrap" align="flex-start">
              <SubmissionPair
                host={row.targetImage}
                remix={row.image}
                hostCaption="Yours"
                remixCaption="Theirs"
                hostLabel="Open your image in a new tab"
                remixLabel="Open this remix in a new tab"
                hostMissing="Your image is no longer available to preview"
                withheldHref={withheldHref}
              />
              <Stack gap={4}>
                <Text size="sm">
                  <Text span fw={600}>
                    {row.placer?.username ?? 'Someone'}
                  </Text>{' '}
                  wants to feature this on your image
                </Text>
                {/* Nothing was paid on a free row, so a Buzz chip there reads
                    as an offer of 0 rather than as a different kind of offer. */}
                {row.free ? (
                  <PlacementFreeBadge noun="submission" />
                ) : (
                  <Group gap={4}>
                    <CurrencyIcon currency={Currency.BUZZ} size={12} />
                    <Text size="xs" c="dimmed">
                      {row.amount}
                    </Text>
                  </Group>
                )}
                <Text size="xs" c="dimmed">
                  Sent {agedLabel(row.createdAt)}
                  {row.expiresAt ? ` — expires ${formatDate(row.expiresAt)}` : ''}
                </Text>
              </Stack>
            </Group>

            {/* Stacked and equal width, matching the manage modal: the pair is
                one decision with two answers, not a row of buttons. */}
            <Stack gap={6} className="w-28 shrink-0">
              <Button
                size="compact-sm"
                fullWidth
                leftSection={<IconCheck size={14} />}
                loading={busyWith(row.id, 'approve')}
                // Every action button is disabled while any one is in flight.
                // These move money, and the list is account-wide, so a second
                // click during the round trip is a plausible mistake rather
                // than a theoretical one.
                disabled={act.isPending}
                onClick={() => act.mutate({ placementId: row.id, action: 'approve' })}
              >
                Approve
              </Button>
              <Button
                size="compact-sm"
                fullWidth
                variant="default"
                leftSection={<IconX size={14} />}
                loading={busyWith(row.id, 'decline')}
                disabled={act.isPending}
                onClick={() => act.mutate({ placementId: row.id, action: 'decline' })}
              >
                Decline
              </Button>
            </Stack>
          </Group>
        </Card>
      ))}

      {hasMore && (
        <Button variant="default" loading={isFetchingMore} onClick={onLoadMore}>
          Load more
        </Button>
      )}
    </Stack>
  );
}

type SentRow = RouterOutput['placement']['getMyRemixGallerySubmissions'][number];

function SentTab({ rows, isLoading }: { rows: SentRow[]; isLoading: boolean }) {
  const utils = trpc.useUtils();
  const withheldHref = useWithheldHref();

  const retract = trpc.placement.retractRemixGallerySubmission.useMutation({
    onSuccess: () => {
      // States what happened, not what the ledger has done. A successful settle
      // means the transition was claimed, not that the refund leg has paid —
      // chunk C ships a sweep for unpaid legs precisely because those differ.
      // No Buzz claim: this fires for free submissions too, which put nothing
      // in escrow, and the row-level confirmation above already said what each
      // kind gets back. A blanket "your Buzz is on its way" is false on half of
      // them and unverifiable on the other half from here.
      showSuccessNotification({
        title: 'Withdrawn',
        message: 'Your submission is withdrawn.',
      });
      utils.placement.invalidate();
    },
    onError: (error) =>
      showErrorNotification({ title: "Couldn't withdraw that", error: new Error(error.message) }),
  });

  if (isLoading)
    return (
      <Group justify="center" py="xl">
        <Loader />
      </Group>
    );

  if (!rows.length)
    return (
      <Alert color="gray">
        <Text size="sm">You haven&apos;t submitted any remixes yet.</Text>
        <Text size="sm" c="dimmed" mt={4}>
          Remix an image you like, then submit it to that creator&apos;s gallery from the image
          page.
        </Text>
      </Alert>
    );

  return (
    <Stack gap="md">
      <Text size="sm" c="dimmed">
        You can withdraw a submission any time before the creator reviews it. A paid one refunds in
        full; a free one does not return your daily free placement. Once it has been accepted there
        is nothing to withdraw.
      </Text>

      {/* Neither queue pages. A list that stops at the cap and says nothing
          reads as complete. */}
      {rows.length >= REMIX_GALLERY_QUEUE_LIMIT && (
        <Text size="xs" c="dimmed">
          Showing the first {REMIX_GALLERY_QUEUE_LIMIT}.
        </Text>
      )}

      {rows.map((row) => (
        <Card key={row.id} withBorder>
          <Group justify="space-between" wrap="nowrap" align="flex-start">
            <Group gap="sm" wrap="nowrap" align="flex-start">
              <SubmissionPair
                host={row.targetImage}
                remix={row.image}
                hostCaption="Theirs"
                remixCaption="Yours"
                hostLabel="Open the gallery image in a new tab"
                remixLabel="Open your remix in a new tab"
                hostMissing="This gallery image is no longer available to preview"
                withheldHref={withheldHref}
              />
              <Stack gap={4}>
                <Group gap="xs">
                  <Badge
                    size="sm"
                    variant="light"
                    color={row.status === 'approved' ? 'green' : 'yellow'}
                  >
                    {row.status === 'approved' ? 'Live' : 'Awaiting review'}
                  </Badge>
                  {row.free ? (
                    <Badge size="sm" variant="light" color="green">
                      Free
                    </Badge>
                  ) : (
                    <Group gap={4}>
                      <CurrencyIcon currency={Currency.BUZZ} size={12} />
                      <Text size="xs" c="dimmed">
                        {row.amount}
                      </Text>
                    </Group>
                  )}
                </Group>
                <Text size="sm">On {row.owner?.username ?? 'a creator'}&apos;s image</Text>
                <Text size="xs" c="dimmed">
                  Submitted {agedLabel(row.createdAt)}
                  {row.status === 'pending' && row.expiresAt
                    ? ` — expires ${formatDate(row.expiresAt)}`
                    : ''}
                </Text>
              </Stack>
            </Group>

            {row.status === 'pending' && (
              <Button
                // Red, and lighter than the moderator takedown in the manage
                // modal — that one is a filled icon acting on someone else's
                // content, this is a text button undoing your own. Both can be
                // on screen in one session and they must not read alike.
                color="red"
                variant="light"
                size="compact-sm"
                className="w-28 shrink-0"
                loading={retract.isPending && retract.variables?.placementId === row.id}
                disabled={retract.isPending}
                onClick={() =>
                  openConfirmModal({
                    title: 'Withdraw this submission',
                    children: (
                      <Text size="sm">
                        It comes out of {row.owner?.username ?? 'the creator'}&apos;s review queue
                        {row.free
                          ? '. Your free placement for today stays spent, and free is once per gallery — withdrawing does not give it back, so you will not be able to submit here for free again.'
                          : ` and your ${row.amount} Buzz starts on its way back. You can submit it again later.`}
                      </Text>
                    ),
                    labels: { confirm: 'Withdraw', cancel: 'Keep it' },
                    confirmProps: { color: 'red' },
                    onConfirm: () => retract.mutate({ placementId: row.id }),
                  })
                }
              >
                Withdraw
              </Button>
            )}
          </Group>
        </Card>
      ))}
    </Stack>
  );
}
