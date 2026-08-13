import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Center,
  Container,
  Group,
  Loader,
  Skeleton,
  Stack,
  Tabs,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { IconCheck, IconExternalLink, IconPhotoOff, IconX } from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { Meta } from '~/components/Meta/Meta';
import { SubmissionThumb } from '~/components/RemixGallery/SubmissionThumb';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
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
export default function RemixSubmissions() {
  const router = useRouter();
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
    {},
    { getNextPageParam: (lastPage) => lastPage.nextCursor }
  );
  const { data: sent, isLoading: sentLoading } =
    trpc.placement.getMyRemixGallerySubmissions.useQuery();

  const receivedRows = received?.pages.flatMap((page) => page.items) ?? [];
  const waiting = receivedRows.length;

  return (
    <>
      <Meta title="Your remix gallery submissions" deIndex />
      <Container size="md" my="md">
        <Stack gap="md">
          <div>
            <Title order={2}>Remix gallery submissions</Title>
            <Text size="sm" c="dimmed">
              Remixes waiting on your images, and the ones you have sent to other creators.
            </Text>
          </div>

          <Tabs value={tab} onChange={setTab} keepMounted={false}>
            <Tabs.List>
              <Tabs.Tab
                value="received"
                rightSection={
                  waiting || hasNextPage ? (
                    <Badge size="sm" variant="filled" circle>
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
        </Stack>
      </Container>
    </>
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
          When someone pays to feature their remix on one of your images, it appears here for you to
          approve or decline. You choose whether to accept them at all, and what they cost, in{' '}
          <Anchor component={Link} href="/user/account">
            your account settings
          </Anchor>
          .
        </Text>
      </Alert>
    );

  return (
    <Stack gap="md">
      {!rows.length && (
        <Text size="sm" c="dimmed">
          Nothing on this page can be shown — the images behind these submissions are gone or still
          processing. There are more waiting.
        </Text>
      )}

      {rows.map((row) => (
        <Card key={row.id} withBorder>
          <Group justify="space-between" wrap="nowrap" align="flex-start">
            <Group gap="sm" wrap="nowrap" align="flex-start">
              {row.image && <SubmissionThumb image={row.image} />}
              <Stack gap={4}>
                <Text size="sm">
                  <Text span fw={600}>
                    {row.placer?.username ?? 'Someone'}
                  </Text>{' '}
                  wants to feature this on your image
                </Text>
                <Group gap={4}>
                  <CurrencyIcon currency={Currency.BUZZ} size={12} />
                  <Text size="xs" c="dimmed">
                    {row.amount}
                  </Text>
                </Group>
                <Text size="xs" c="dimmed">
                  Sent {agedLabel(row.createdAt)}
                  {row.expiresAt ? ` — expires ${formatDate(row.expiresAt)}` : ''}
                </Text>
                <Anchor component={Link} href={`/images/${row.targetId}`} size="xs">
                  <Group gap={4} wrap="nowrap">
                    <IconExternalLink size={12} />
                    See your image
                  </Group>
                </Anchor>
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

  const retract = trpc.placement.retractRemixGallerySubmission.useMutation({
    onSuccess: () => {
      // States what happened, not what the ledger has done. A successful settle
      // means the transition was claimed, not that the refund leg has paid —
      // chunk C ships a sweep for unpaid legs precisely because those differ.
      showSuccessNotification({
        title: 'Withdrawn',
        message: 'Your submission is withdrawn. Your Buzz is on its way back.',
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
        You can withdraw a submission any time before the creator reviews it and get your Buzz back
        in full. Once it has been accepted there is nothing to withdraw.
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
              {row.image ? (
                <SubmissionThumb image={row.image} />
              ) : (
                // The row is kept even when its image will not resolve —
                // unpublished, deleted, flagged — because the withdraw beside it
                // is the only route back to the escrow. A placeholder says the
                // preview is gone without implying the submission is.
                <Tooltip label="This image is no longer available to preview" withArrow>
                  <div className="relative w-20 shrink-0">
                    <Skeleton animate={false} className="aspect-square w-full rounded-md" />
                    <Center className="absolute inset-0">
                      <IconPhotoOff size={20} className="text-dimmed" />
                    </Center>
                  </div>
                </Tooltip>
              )}
              <Stack gap={4}>
                <Group gap="xs">
                  <Badge
                    size="sm"
                    variant="light"
                    color={row.status === 'approved' ? 'green' : 'yellow'}
                  >
                    {row.status === 'approved' ? 'Live' : 'Awaiting review'}
                  </Badge>
                  <Group gap={4}>
                    <CurrencyIcon currency={Currency.BUZZ} size={12} />
                    <Text size="xs" c="dimmed">
                      {row.amount}
                    </Text>
                  </Group>
                </Group>
                <Text size="sm">On {row.owner?.username ?? 'a creator'}&apos;s image</Text>
                <Text size="xs" c="dimmed">
                  Submitted {agedLabel(row.createdAt)}
                  {row.status === 'pending' && row.expiresAt
                    ? ` — expires ${formatDate(row.expiresAt)}`
                    : ''}
                </Text>
                <Anchor component={Link} href={`/images/${row.targetId}`} size="xs">
                  <Group gap={4} wrap="nowrap">
                    <IconExternalLink size={12} />
                    See the gallery
                  </Group>
                </Anchor>
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
                        and your {row.amount} Buzz starts on its way back. You can submit it again
                        later.
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

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session }) => {
    if (!session?.user || session.user.bannedAt)
      return { redirect: { destination: '/', permanent: false } };
  },
});
