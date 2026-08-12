import { Alert, Anchor, Card, Checkbox, Container, Group, Stack, Text, Title } from '@mantine/core';
import { IconExternalLink } from '@tabler/icons-react';
import Link from 'next/link';
import { useState } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { EdgeImage } from '~/components/EdgeMedia/EdgeImage';
import { Meta } from '~/components/Meta/Meta';
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
  const { data: pending, isLoading } = trpc.placement.getPending.useQuery();
  const [selected, setSelected] = useState<number[]>([]);

  const rows = pending ?? [];
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
                label="Select all"
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
          {!isLoading && !rows.length && (
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
                    <EdgeImage
                      src={art.url}
                      alt={`:${art.slug}:`}
                      options={{ height: 96, anim: art.animated, optimized: true }}
                      style={{ height: 48, width: 'auto' }}
                    />
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
                    compact
                  />
                </Group>
              </Card>
            );
          })}
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
