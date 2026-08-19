import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Checkbox,
  Container,
  Group,
  Loader,
  Stack,
  Tabs,
  Text,
  Title,
} from '@mantine/core';
import { IconExternalLink } from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { EdgeImage } from '~/components/EdgeMedia/EdgeImage';
import { Meta } from '~/components/Meta/Meta';
import { PlacementFreeBadge } from '~/components/Placement/PlacementFreeBadge';
import { PlacementFreeFilter } from '~/components/Placement/PlacementFreeFilter';
import { selectionAfterHidingFree, visibleQueueRows } from '~/components/Placement/free-filter';
import { stickerArtworkStyle } from '~/components/Sticker/placement-appearance';
import { StickerPlacementActions } from '~/components/Sticker/StickerPlacementActions';
import { placementAmountLine, selectionFree } from '~/components/Sticker/payout-copy';
import { WithheldThumb } from '~/components/RemixGallery/SubmissionPair';
import { useStickerCosmetics } from '~/components/Sticker/sticker.util';
import { useServerDomains } from '~/providers/AppProvider';
import { syncAccount } from '~/utils/sync-account';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { STICKER_PLACEMENT_QUEUE_LIMIT } from '~/shared/utils/sticker-placement';
import type { RouterOutput } from '~/types/router';
import { formatDate } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';

const TABS = ['received', 'sent'] as const;
type TabValue = (typeof TABS)[number];

const isTabValue = (value: unknown): value is TabValue => TABS.includes(value as TabValue);

/**
 * Both directions of a sticker placement: what is waiting on the creator's
 * images, and what they have placed on other people's.
 *
 * Received is the default and the only side with actions on it — a placement
 * sits pending until the owner rules on it, and expires if they never do. Tab
 * values, badge and empty-state rules are the remix gallery page's, because
 * this is the same job on a different surface and a creator should only have to
 * learn it once.
 */
export default function StickerPlacements() {
  const router = useRouter();
  // Marked on each row rather than filtered on: a placement hidden for being
  // outside your own band still expires, and expiry pays the placer back and
  // costs the owner their fee.
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
  const { data, isLoading, isError, fetchNextPage, hasNextPage, isFetchingNextPage } =
    trpc.placement.getPending.useInfiniteQuery(
      { browsingLevel },
      { getNextPageParam: (lastPage) => lastPage.nextCursor }
    );
  const {
    data: placed,
    isLoading: placedLoading,
    isError: placedFailed,
  } = trpc.placement.getMyStickerPlacements.useQuery({ browsingLevel });

  const loaded = data?.pages.flatMap((page) => page.items) ?? [];
  const waiting = loaded.length;

  return (
    <>
      <Meta title="Your sticker placements" deIndex />
      <Container size="md" my="md">
        <Stack gap="md">
          <div>
            <Title order={2}>Sticker placements</Title>
            <Text size="sm" c="dimmed">
              Stickers waiting on your images, and the ones you have placed on other creators&apos;.
            </Text>
          </div>

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
              <Tabs.Tab value="sent">Placed</Tabs.Tab>
            </Tabs.List>

            <Tabs.Panel value="received" pt="md">
              <ReceivedTab
                loaded={loaded}
                isLoading={isLoading}
                isError={isError}
                hasMore={!!hasNextPage}
                isFetchingMore={isFetchingNextPage}
                onLoadMore={() => fetchNextPage()}
              />
            </Tabs.Panel>

            <Tabs.Panel value="sent" pt="md">
              <PlacedTab rows={placed ?? []} isLoading={placedLoading} isError={placedFailed} />
            </Tabs.Panel>
          </Tabs>
        </Stack>
      </Container>
    </>
  );
}

/**
 * Where to send someone whose domain will not serve an image. The row stays so
 * the placement can still be answered or found; this is the only route left to
 * the picture itself, since no asset was sent to reveal.
 */
function useWithheldHref() {
  const domains = useServerDomains();
  return (image: { id: number }) => syncAccount(`//${domains.red}/images/${image.id}`);
}

type ReceivedRow = RouterOutput['placement']['getPending']['items'][number];
type PlacedRow = RouterOutput['placement']['getMyStickerPlacements'][number];

/** The image a placement sits on, or the fact this domain may not serve it. */
function PlacementThumb({
  image,
  withheldHref,
}: {
  image: ReceivedRow['image'] | PlacedRow['image'];
  withheldHref: (image: { id: number }) => string;
}) {
  if (!image) return null;

  // `anim={false}` is what keeps a list of these quiet: it suppresses the
  // autoplay observer and the autoPlay attribute, leaving a poster frame that
  // plays on hover. The type has to be the real one — forcing `image` asks the
  // CDN to transform a video as a still, which it will not do.
  return image.viewable ? (
    <EdgeMedia
      src={image.url}
      type={image.type}
      anim={false}
      name={image.name ?? image.id.toString()}
      alt={image.name ?? undefined}
      width={180}
      style={{ width: 90, height: 'auto', borderRadius: 6 }}
    />
  ) : (
    <WithheldThumb nsfwLevel={image.nsfwLevel} href={withheldHref(image)} />
  );
}

/**
 * The sticker itself, drawn with the placer's own opacity and flip rather than
 * at full strength.
 *
 * This is the queue an owner is most likely to approve from, and it is the
 * small-card review the opacity floor exists because of: a faint sticker
 * previewed as solid is approved on the strength of something the page never
 * showed.
 *
 * Named, and on a checkered plate, because both cost the faintness back. A 30%
 * sticker against a flat card reads fainter than the same sticker over busy
 * artwork, so the honest preview is also the one that is hardest to identify —
 * and the row has no other statement of WHICH sticker it is. "See it on the
 * image" remains the composite view.
 */
function StickerArt({
  art,
  data,
}: {
  art: { url: string; slug: string; name: string; animated?: boolean } | undefined;
  data: ReceivedRow['data'] | PlacedRow['data'];
}) {
  if (!art) return null;

  return (
    <Stack gap={2} align="center">
      <div className="rounded-md bg-gray-2 p-1 dark:bg-dark-5">
        <EdgeImage
          src={art.url}
          alt={`:${art.slug}:`}
          options={{ height: 96, anim: art.animated, optimized: true }}
          style={{ height: 48, width: 'auto', ...stickerArtworkStyle(data) }}
        />
      </div>
      <Text size="10px" c="dimmed" className="max-w-[80px] truncate">
        {art.name}
      </Text>
    </Stack>
  );
}

function ReceivedTab({
  loaded,
  isLoading,
  isError,
  hasMore,
  isFetchingMore,
  onLoadMore,
}: {
  loaded: ReceivedRow[];
  isLoading: boolean;
  isError: boolean;
  hasMore: boolean;
  isFetchingMore: boolean;
  onLoadMore: () => void;
}) {
  const withheldHref = useWithheldHref();
  const [selected, setSelected] = useState<number[]>([]);
  const [showFree, setShowFree] = useState(true);

  const rows = visibleQueueRows(loaded, showFree);
  const { sticker } = useStickerCosmetics(rows.map((row) => row.data.cosmeticId));

  const allSelected = rows.length > 0 && selected.length === rows.length;

  // All free, all paid, or mixed. Derived beside `declineConsequence`, which is
  // the only consumer and where the mixed branch is already covered.
  const selectedFree = selectionFree(selected, rows);

  const toggle = (id: number) =>
    setSelected((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id]
    );

  // Hiding the free rows takes them out of the selection with them. Approve and
  // Decline are irreversible and both say something about money, so a selection
  // that outlives the rows it was made from would act on placements the owner
  // can no longer see.
  const changeShowFree = (next: boolean) => {
    setShowFree(next);
    if (!next) setSelected((current) => selectionAfterHidingFree(current, loaded));
  };

  return (
    <Stack gap="md">
      <Group justify="space-between" align="start" wrap="nowrap">
        <Text size="sm" c="dimmed">
          Only you and the placer can see these. Unanswered ones expire after 48 hours.
        </Text>
        <Group gap="sm" wrap="nowrap" className="shrink-0">
          {rows.length > 0 && (
            <Checkbox
              // Names what it selects. With the queue paged it reaches the rows
              // on screen, and an owner who bulk-declined believing they had
              // cleared 200 would find 150 still waiting. With the free ones
              // hidden it reaches those on screen too, not the hidden ones
              // behind them.
              label={hasMore ? 'Select all loaded' : 'Select all'}
              checked={allSelected}
              indeterminate={selected.length > 0 && !allSelected}
              onChange={() => setSelected(allSelected ? [] : rows.map((row) => row.id))}
              className="shrink-0"
            />
          )}
          {/* Only once there is something to hide. A control that changes
              nothing still asks the owner to work out what it does. */}
          {loaded.some((row) => row.free) && (
            <PlacementFreeFilter show={showFree} onChange={changeShowFree} noun="placements" />
          )}
        </Group>
      </Group>

      {selected.length > 0 && (
        <Card withBorder p="xs">
          <Group justify="space-between">
            <Text size="sm">{selected.length} selected</Text>
            <StickerPlacementActions
              placementIds={selected}
              free={selectedFree}
              onDone={() => setSelected([])}
            />
          </Group>
        </Card>
      )}

      {isLoading && <Text size="sm">Loading…</Text>}
      {/* A failed read has no pages, so `hasMore` is false and the empty state
          below would claim the queue is clear. */}
      {isError && (
        <Alert color="red">
          <Text size="sm">Couldn&rsquo;t load your queue. Refresh to try again.</Text>
        </Alert>
      )}
      {/* `&& !hasMore`: a page whose rows were all dropped returns nothing with
          a cursor still set, and "nothing waiting" over a queue that has more is
          the failure paging exists to end. */}
      {/* Both of these ask whether the QUEUE is empty, which is a different
          question from whether anything is on screen — with the free ones
          hidden, "nothing waiting" would be the owner's own filter talking back
          to them as a fact about their images. */}
      {!isLoading && !isError && !loaded.length && !hasMore && (
        <Alert>
          <Text size="sm">Nothing waiting. Placements you approve show up on your images.</Text>
        </Alert>
      )}

      {!loaded.length && hasMore && (
        <Text size="sm" c="dimmed">
          Nothing on this page can be shown. There are more waiting.
        </Text>
      )}

      {!!loaded.length && !rows.length && (
        <Text size="sm" c="dimmed">
          Everything waiting on you is a free placement, and free ones are hidden.
        </Text>
      )}

      {rows.map((row) => (
        <Card key={row.id} withBorder p="sm">
          <Group align="start" wrap="nowrap" gap="sm">
            <Checkbox
              checked={selected.includes(row.id)}
              onChange={() => toggle(row.id)}
              aria-label="Select this placement"
            />

            <PlacementThumb image={row.image} withheldHref={withheldHref} />
            <StickerArt art={sticker.get(row.data.cosmeticId)} data={row.data} />

            <Stack gap={2} className="flex-1">
              <Text size="sm">
                <Text span fw={600}>
                  {row.placer?.username ?? 'Someone'}
                </Text>{' '}
                {/* Both arms in `payout-copy`, not a ternary here: this is the
                    only money statement on the card the Approve and Decline
                    buttons sit under, and nothing under `src/pages` can be
                    tested. */}
                {placementAmountLine(row.free, row.amount)}
              </Text>
              {row.free && <PlacementFreeBadge noun="placement" />}
              <Text size="xs" c="dimmed">
                Placed {formatDate(row.createdAt)}
                {row.expiresAt ? ` · expires ${formatDate(row.expiresAt)}` : ''}
              </Text>
              {/* Shown here because this is where the note is decided on. An
                  owner choosing "Approve without note" needs to have read the
                  note in the same glance as the sticker. */}
              {row.data.comment && (
                <Text size="sm" className="whitespace-pre-wrap break-words">
                  &ldquo;{row.data.comment}&rdquo;
                </Text>
              )}
              <Anchor component={Link} href={`/images/${row.targetId}`} size="xs" target="_blank">
                <Group gap={4} wrap="nowrap">
                  <IconExternalLink size={12} />
                  See it on the image
                </Group>
              </Anchor>
            </Stack>

            <StickerPlacementActions
              placementIds={[row.id]}
              hasComment={!!row.data.comment}
              free={row.free}
              stacked
              compact
            />
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

function PlacedTab({
  rows,
  isLoading,
  isError,
}: {
  rows: PlacedRow[];
  isLoading: boolean;
  isError: boolean;
}) {
  const withheldHref = useWithheldHref();
  const { sticker } = useStickerCosmetics(rows.map((row) => row.data.cosmeticId));

  if (isLoading)
    return (
      <Group justify="center" py="xl">
        <Loader />
      </Group>
    );

  // Said out loud rather than falling through to the empty state below: "you
  // haven't placed any" over a list that failed to load tells a placer their
  // Buzz bought nothing.
  if (isError)
    return (
      <Alert color="red">
        <Text size="sm">Couldn&rsquo;t load your placements. Refresh to try again.</Text>
      </Alert>
    );

  if (!rows.length)
    return (
      <Alert color="gray">
        <Text size="sm">You haven&apos;t placed any stickers yet.</Text>
        <Text size="sm" c="dimmed" mt={4}>
          Open an image that accepts stickers and place one from your collection. It shows up here
          until the creator approves or declines it.
        </Text>
      </Alert>
    );

  return (
    <Stack gap="md">
      {/* "Any Buzz you paid" rather than "your Buzz": a free placement moves
          none, and both kinds are in this list. */}
      <Text size="sm" c="dimmed">
        A pending placement is waiting on that creator. Unanswered ones expire after 48 hours, and
        any Buzz you paid comes back.
      </Text>

      {/* This list does not page. One that stops at the cap and says nothing
          reads as complete. */}
      {rows.length >= STICKER_PLACEMENT_QUEUE_LIMIT && (
        <Text size="xs" c="dimmed">
          Showing the first {STICKER_PLACEMENT_QUEUE_LIMIT}.
        </Text>
      )}

      {rows.map((row) => (
        <Card key={row.id} withBorder p="sm">
          <Group align="start" wrap="nowrap" gap="sm">
            <PlacementThumb image={row.image} withheldHref={withheldHref} />
            <StickerArt art={sticker.get(row.data.cosmeticId)} data={row.data} />

            <Stack gap={2} className="flex-1">
              <Group gap="xs">
                <Badge
                  size="sm"
                  variant="light"
                  color={row.status === 'approved' ? 'green' : 'yellow'}
                >
                  {row.status === 'approved' ? 'Live' : 'Awaiting review'}
                </Badge>
                {/* The same rule the owner queue's headline follows: a free row
                    carries `amount: 0`, so naming an amount here would report a
                    payment of zero instead of no payment. */}
                {row.free ? (
                  <PlacementFreeBadge noun="placement" />
                ) : (
                  <Text size="xs" c="dimmed">
                    {row.amount} Buzz
                  </Text>
                )}
              </Group>
              <Text size="sm">On {row.owner?.username ?? 'a creator'}&apos;s image</Text>
              <Text size="xs" c="dimmed">
                Placed {formatDate(row.createdAt)}
                {row.status === 'pending' && row.expiresAt
                  ? ` · expires ${formatDate(row.expiresAt)}`
                  : ''}
              </Text>
              {row.data.comment && (
                <Text size="sm" className="whitespace-pre-wrap break-words">
                  &ldquo;{row.data.comment}&rdquo;
                </Text>
              )}
              <Anchor component={Link} href={`/images/${row.targetId}`} size="xs" target="_blank">
                <Group gap={4} wrap="nowrap">
                  <IconExternalLink size={12} />
                  See it on the image
                </Group>
              </Anchor>
            </Stack>
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
