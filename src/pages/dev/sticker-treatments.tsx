import { Badge, Container, SegmentedControl, Stack, Text, Title } from '@mantine/core';
import type { GetServerSideProps } from 'next';
import { useMemo, useState } from 'react';
import { EdgeImage } from '~/components/EdgeMedia/EdgeImage';
import { useStickerPlacements } from '~/components/Sticker/placement.util';
import { StickerPlacementOverlay } from '~/components/Sticker/StickerPlacementOverlay';
import {
  STICKER_TREATMENT_KEYS,
  STICKER_TREATMENTS,
  type StickerTreatmentKey,
} from '~/components/Sticker/treatments/sticker-treatments';
import { dbRead } from '~/server/db/client';

type DevImage = { id: number; url: string; width: number | null; height: number | null };

/**
 * Side-by-side comparison of the candidate sticker treatments, on seeded content.
 *
 * Development only: the handler below 404s anywhere else, so the route does not
 * exist in a production build even though the file ships with it. The same
 * candidates are reachable on the real surfaces with `?stickerTreatment=<key>`,
 * which is likewise development-only — see `useStickerTreatment`.
 */
export const getServerSideProps: GetServerSideProps = async () => {
  if (process.env.NODE_ENV === 'production') return { notFound: true };

  const images = await dbRead.image.findMany({
    where: { id: { in: SEEDED_IMAGE_IDS } },
    select: { id: true, url: true, width: true, height: true },
  });

  return { props: { images } };
};

/** From the placement seed script; see the sticker handoff notes. */
const SEEDED_IMAGE_IDS = [135356251, 131420251, 130110988, 45392021, 45391881];

const CARD_WIDTH = 300;
const DETAIL_WIDTH = 620;

function Surface({
  image,
  treatment,
  width,
}: {
  image: DevImage;
  treatment: StickerTreatmentKey;
  width: number;
}) {
  const imageIds = useMemo(() => [image.id], [image.id]);
  const { byImage } = useStickerPlacements(imageIds);
  const placements = byImage.get(image.id) ?? [];

  const ratio = image.width && image.height ? image.height / image.width : 1;
  const height = Math.round(width * ratio);
  const isCard = width === CARD_WIDTH;

  return (
    <div className="relative overflow-hidden rounded" style={{ width, height }}>
      <EdgeImage
        src={image.url}
        alt={`image ${image.id}`}
        options={{ width }}
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
      />
      {placements.length > 0 && (
        <StickerPlacementOverlay
          placements={placements}
          interactive={!isCard}
          surface={isCard ? 'card' : 'detail'}
          treatment={treatment}
        />
      )}
    </div>
  );
}

export default function StickerTreatmentsPage({ images }: { images: DevImage[] }) {
  const [treatment, setTreatment] = useState<StickerTreatmentKey>('lift');

  return (
    <Container size="xl" py="lg">
      <Stack gap="md">
        <div>
          <Title order={2}>Sticker treatments</Title>
          <Text size="sm" c="dimmed">
            Development only. The same options apply on any real image or feed with{' '}
            <code>?stickerTreatment={treatment}</code>.
          </Text>
        </div>

        <SegmentedControl
          value={treatment}
          onChange={(value) => setTreatment(value as StickerTreatmentKey)}
          data={STICKER_TREATMENT_KEYS.map((key) => ({
            value: key,
            label: STICKER_TREATMENTS[key].label,
          }))}
        />

        <Text size="sm">{STICKER_TREATMENTS[treatment].note}</Text>

        {!images.length && (
          <Text c="red">
            No seeded images found. Re-run seed-placement-review.sql — dev rolls from a prod backup
            and drops the seed.
          </Text>
        )}

        {images.map((image) => (
          <Stack key={image.id} gap="xs">
            <Badge variant="light">image {image.id}</Badge>
            <div className="flex flex-wrap items-start gap-4">
              <Stack gap={4}>
                <Text size="xs" c="dimmed">
                  detail ({DETAIL_WIDTH}px)
                </Text>
                <Surface image={image} treatment={treatment} width={DETAIL_WIDTH} />
              </Stack>
              <Stack gap={4}>
                <Text size="xs" c="dimmed">
                  card ({CARD_WIDTH}px, animating treatments fall back)
                </Text>
                <Surface image={image} treatment={treatment} width={CARD_WIDTH} />
              </Stack>
            </div>
          </Stack>
        ))}
      </Stack>
    </Container>
  );
}
