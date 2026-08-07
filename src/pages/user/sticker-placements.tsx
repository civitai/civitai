import { Alert, Anchor, Card, Checkbox, Container, Group, Stack, Text, Title } from '@mantine/core';
import { IconExternalLink } from '@tabler/icons-react';
import Link from 'next/link';
import { useState } from 'react';
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

  const toggle = (id: number) =>
    setSelected((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id]
    );

  return (
    <>
      <Meta title="Stickers awaiting your review" deIndex />
      <Container size="md" my="md">
        <Stack gap="md">
          <div>
            <Title order={2}>Stickers awaiting your review</Title>
            <Text size="sm" c="dimmed">
              Someone has paid to place a sticker on your work. Until you answer, only they can see
              it. Anything you leave expires after 48 hours and refunds them in full.
            </Text>
          </div>

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
                    <EdgeImage
                      src={row.image.url}
                      alt={row.image.name ?? undefined}
                      options={{ width: 120 }}
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

                  <StickerPlacementActions placementIds={[row.id]} compact />
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
