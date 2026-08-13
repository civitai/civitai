import {
  Alert,
  Anchor,
  Button,
  Card,
  Checkbox,
  Container,
  Group,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { IconExternalLink } from '@tabler/icons-react';
import Link from 'next/link';
import { useState } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { EdgeImage } from '~/components/EdgeMedia/EdgeImage';
import { Meta } from '~/components/Meta/Meta';
import { stickerArtworkStyle } from '~/components/Sticker/placement-appearance';
import { StickerPlacementActions } from '~/components/Sticker/StickerPlacementActions';
import { useStickerCosmetics } from '~/components/Sticker/sticker.util';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { formatDate } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';

/**
 * Everything waiting on the creator, in one place.
 *
 * The notification takes you to the image, because deciding means seeing the
 * sticker on the work it was placed on. This page is the other half of that: a
 * way to find what is outstanding without digging back through notifications,
 * and to clear a backlog in one pass.
 */
export default function StickerPlacements() {
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    trpc.placement.getPending.useInfiniteQuery(
      {},
      { getNextPageParam: (lastPage) => lastPage.nextCursor }
    );
  const [selected, setSelected] = useState<number[]>([]);

  const rows = data?.pages.flatMap((page) => page.items) ?? [];
  const cosmeticIds = rows.map((row) => row.data.cosmeticId);
  const { sticker } = useStickerCosmetics(cosmeticIds);

  const allSelected = rows.length > 0 && selected.length === rows.length;

  const toggle = (id: number) =>
    setSelected((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id]
    );

  return (
    <>
      <Meta title="Stickers awaiting your review" deIndex />
      <Container size="md" my="md">
        <Stack gap="md">
          <Group justify="space-between" align="start" wrap="nowrap">
            <div>
              <Title order={2}>Stickers awaiting your review</Title>
              <Text size="sm" c="dimmed">
                Only you and the placer can see these. Unanswered ones expire after 48 hours.
              </Text>
            </div>
            {rows.length > 0 && (
              <Checkbox
                // Names what it selects. With the queue paged it reaches the
                // rows on screen, and an owner who bulk-declined believing they
                // had cleared 200 would find 150 still waiting.
                label={hasNextPage ? 'Select all loaded' : 'Select all'}
                checked={allSelected}
                indeterminate={selected.length > 0 && !allSelected}
                onChange={() => setSelected(allSelected ? [] : rows.map((row) => row.id))}
                className="shrink-0"
              />
            )}
          </Group>

          {selected.length > 0 && (
            <Card withBorder p="xs">
              <Group justify="space-between">
                <Text size="sm">{selected.length} selected</Text>
                <StickerPlacementActions placementIds={selected} onDone={() => setSelected([])} />
              </Group>
            </Card>
          )}

          {isLoading && <Text size="sm">Loading…</Text>}
          {/* `&& !hasNextPage`: a page whose rows were all dropped returns
              nothing with a cursor still set, and "nothing waiting" over a
              queue that has more is the failure paging exists to end. */}
          {!isLoading && !rows.length && !hasNextPage && (
            <Alert>
              <Text size="sm">Nothing waiting. Placements you approve show up on your images.</Text>
            </Alert>
          )}

          {rows.map((row) => {
            const art = sticker.get(row.data.cosmeticId);
            return (
              <Card key={row.id} withBorder p="sm">
                <Group align="start" wrap="nowrap" gap="sm">
                  <Checkbox
                    checked={selected.includes(row.id)}
                    onChange={() => toggle(row.id)}
                    aria-label="Select this placement"
                  />

                  {row.image && (
                    // `anim={false}` is what keeps a list of these quiet: it
                    // suppresses the autoplay observer and the autoPlay
                    // attribute, leaving a poster frame that plays on hover.
                    // The type has to be the real one — forcing `image` asks the
                    // CDN to transform a video as a still, which it will not do.
                    <EdgeMedia
                      src={row.image.url}
                      type={row.image.type}
                      anim={false}
                      name={row.image.name ?? row.image.id.toString()}
                      alt={row.image.name ?? undefined}
                      width={180}
                      style={{ width: 90, height: 'auto', borderRadius: 6 }}
                    />
                  )}

                  {art && (
                    // Drawn with the placer's own opacity and flip, not at full
                    // strength. This is the queue an owner is most likely to
                    // approve from, and it is the small-card review the opacity
                    // floor exists because of: a faint sticker previewed as
                    // solid here is approved on the strength of something the
                    // page never showed.
                    //
                    // Named, and on a checkered plate, because both cost the
                    // faintness back. A 30% sticker against a flat card reads
                    // fainter than the same sticker over busy artwork, so the
                    // honest preview is also the one that is hardest to identify
                    // — and this row had no other statement of WHICH sticker it
                    // is. "See it on the image" remains the composite view.
                    <Stack gap={2} align="center">
                      <div className="rounded-md bg-gray-2 p-1 dark:bg-dark-5">
                        <EdgeImage
                          src={art.url}
                          alt={`:${art.slug}:`}
                          options={{ height: 96, anim: art.animated, optimized: true }}
                          style={{ height: 48, width: 'auto', ...stickerArtworkStyle(row.data) }}
                        />
                      </div>
                      <Text size="10px" c="dimmed" className="max-w-[80px] truncate">
                        {art.name}
                      </Text>
                    </Stack>
                  )}

                  <Stack gap={2} className="flex-1">
                    <Text size="sm">
                      <Text span fw={600}>
                        {row.placer?.username ?? 'Someone'}
                      </Text>{' '}
                      paid{' '}
                      <Text span fw={600}>
                        {row.amount}
                      </Text>{' '}
                      Buzz
                    </Text>
                    <Text size="xs" c="dimmed">
                      Placed {formatDate(row.createdAt)}
                      {row.expiresAt ? ` · expires ${formatDate(row.expiresAt)}` : ''}
                    </Text>
                    {/* Shown here because this is where the note is decided on.
                        An owner choosing "Approve without note" needs to have
                        read the note in the same glance as the sticker. */}
                    {row.data.comment && (
                      <Text size="sm" className="whitespace-pre-wrap break-words">
                        &ldquo;{row.data.comment}&rdquo;
                      </Text>
                    )}
                    <Anchor
                      component={Link}
                      href={`/images/${row.targetId}`}
                      size="xs"
                      target="_blank"
                    >
                      <Group gap={4} wrap="nowrap">
                        <IconExternalLink size={12} />
                        See it on the image
                      </Group>
                    </Anchor>
                  </Stack>

                  <StickerPlacementActions
                    placementIds={[row.id]}
                    hasComment={!!row.data.comment}
                    stacked
                    compact
                  />
                </Group>
              </Card>
            );
          })}

          {hasNextPage && (
            <Button variant="default" loading={isFetchingNextPage} onClick={() => fetchNextPage()}>
              Load more
            </Button>
          )}
        </Stack>
      </Container>
    </>
  );
}

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session }) => {
    if (!session?.user || session.user.bannedAt)
      return { redirect: { destination: '/', permanent: false } };
  },
});
