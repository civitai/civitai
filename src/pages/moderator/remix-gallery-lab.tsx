import { Badge, Card, SegmentedControl, Switch, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import { Page } from '~/components/AppLayout/Page';
import { ImageCard } from '~/components/Cards/ImageCard';
import { ImagesCard } from '~/components/Image/Infinite/ImagesCard';
import { Meta } from '~/components/Meta/Meta';
import { useRemixPeelStore } from '~/components/RemixGallery/remix-card-demo';
import type { ImagesInfiniteModel } from '~/server/services/image.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

/**
 * Component bench for the remix-gallery card indicator (ticket 868kumuhp).
 *
 * Exists because the live feeds are a bad place to iterate: the treatment has to
 * be right at several card widths, and finding a card that carries a gallery
 * meant scrolling a feed until one appeared. Here every card is one, the preview
 * can be pinned open, and the widths that actually broke it are side by side.
 *
 * Not a feature. Delete with the branch.
 */

type Variant = 'feed' | 'home';

/**
 * The widths these cards are really drawn at.
 *
 * 280 is in the list because the sticker chip's own bug report was a 280px card
 * clipping the reaction counts, so it is the width this row is known to fail at.
 */
const WIDTHS = [280, 320, 380, 450];

const IMAGE_IDS = [140555347, 140555295, 140555058];

const mockImage = (id: number, url: string, width: number, height: number) =>
  ({
    id,
    url,
    type: 'image',
    name: null,
    hash: null,
    width,
    height,
    nsfwLevel: 1,
    hasMeta: true,
    onSite: false,
    remixOfId: null,
    ingestion: 'Scanned',
    needsReview: null,
    createdAt: new Date(),
    sortAt: new Date(),
    mimeType: 'image/jpeg',
    postId: 1,
    metadata: { width, height },
    user: {
      id: 1,
      username: 'demo',
      image: null,
      deletedAt: null,
      cosmetics: [],
      profilePicture: null,
    },
    stats: {
      likeCountAllTime: 1400,
      dislikeCountAllTime: 0,
      heartCountAllTime: 58,
      laughCountAllTime: 12,
      cryCountAllTime: 14,
      commentCountAllTime: 3,
      tippedAmountCountAllTime: 775,
      viewCountAllTime: 0,
    },
    reactions: [],
    tags: [],
    cosmetic: null,
  } as unknown as ImagesInfiniteModel);

const IMAGES = [
  mockImage(IMAGE_IDS[0], 'e8e48fe3-d6a5-48ba-af6f-17adb1943919', 1024, 1024),
  mockImage(IMAGE_IDS[1], 'eed4c583-05a8-4b98-9057-58487bcba57f', 832, 1216),
  mockImage(IMAGE_IDS[2], '58156d8e-90b9-4a9c-9f38-7163ddecc144', 1024, 1024),
];

function RemixGalleryLab() {
  const [variant, setVariant] = useState<Variant>('feed');
  const [pinned, setPinned] = useState(true);
  const setState = useRemixPeelStore.setState;

  // Pinning the preview open is the whole point of the bench: the bug being
  // chased is where the panel lands, which is unobservable if it closes the
  // moment focus moves to take a screenshot.
  // Density comes from `?remixdemo=1` in the URL rather than being set here:
  // `useRemixDemoDensity` re-reads the query string on mount and would overwrite
  // anything written from this side, which silently left every card with a count
  // of zero and a bench that measured nothing while reporting no failures.
  useEffect(() => {
    setState({ openId: pinned ? IMAGE_IDS[0] : null });
  }, [pinned, setState]);

  return (
    <>
      <Meta title="Remix gallery - card bench" deIndex />
      <div className="p-4">
        <Text component="div" className="mb-2 flex items-center gap-2 text-xl font-semibold">
          Remix gallery card bench
          <Badge color="gray" variant="light" size="sm">
            868kumuhp
          </Badge>
        </Text>
        <div className="mb-4 flex flex-wrap items-center gap-4">
          <SegmentedControl
            value={variant}
            onChange={(value) => setVariant(value as Variant)}
            data={[
              { value: 'feed', label: 'ImagesCard (images / videos feed)' },
              { value: 'home', label: 'ImageCard (home + collections)' },
            ]}
          />
          <Switch
            checked={pinned}
            onChange={(event) => setPinned(event.currentTarget.checked)}
            label="Pin the preview open on the first card"
          />
        </div>
        <Text size="sm" c="dimmed" className="mb-4">
          Every card here carries a gallery. The preview must sit inside the media box and never
          touch the reaction row below it - that is the failure this bench exists to catch.
        </Text>

        <div className="flex flex-wrap items-start gap-6">
          {WIDTHS.map((width) => (
            <div key={width}>
              <Text size="xs" c="dimmed" className="mb-1">
                {width}px
              </Text>
              <div style={{ width }} className="flex flex-col gap-4">
                {IMAGES.map((image) =>
                  variant === 'feed' ? (
                    <ImagesCard key={image.id} data={image} height={Math.round(width * 1.4)} />
                  ) : (
                    <ImageCard key={image.id} data={image} />
                  )
                )}
              </div>
            </div>
          ))}
        </div>

        <Card className="mt-8 rounded-xl" withBorder>
          <Text size="sm" c="dimmed">
            Reaction-row overlap is measurable rather than a matter of opinion: the preview&apos;s
            bottom edge must equal the media box&apos;s bottom edge, and the reaction row starts
            below that. The bench script asserts exactly that at each width.
          </Text>
        </Card>
      </div>
    </>
  );
}

export const getServerSideProps = createServerSideProps({ requireModerator: true });

export default Page(RemixGalleryLab);
