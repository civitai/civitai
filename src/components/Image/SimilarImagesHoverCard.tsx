import { Anchor, Button, Loader, Slider, Stack, Text } from '@mantine/core';
import NextLink from 'next/link';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { isMoreLikeThisVisible } from '~/components/Image/MoreLikeThisButton';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { HoverCard } from '~/components/MantineOverlays';
import { useHoverCapable } from '~/components/UserAvatar/UserHoverCard';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';

export function SimilarImagesHoverCard({
  image,
  height,
  children,
}: {
  image: Parameters<typeof isMoreLikeThisVisible>[1];
  height?: number;
  children: ReactElement;
}) {
  const features = useFeatureFlags();
  const hoverCapable = useHoverCapable();
  const [opened, setOpened] = useState(false);
  if (!hoverCapable || !isMoreLikeThisVisible(features, image)) return children;

  return (
    <HoverCard
      width={310}
      position="right-start"
      openDelay={650}
      closeDelay={250}
      withinPortal
      withArrow
      withRoles={false}
      onOpen={() => setOpened(true)}
      onClose={() => setOpened(false)}
    >
      <HoverCard.Target>
        <div style={height === undefined ? undefined : { height }}>{children}</div>
      </HoverCard.Target>
      <HoverCard.Dropdown onClick={(event) => event.stopPropagation()}>
        {opened && <SimilarImagesPreview key={image.id} imageId={image.id} />}
      </HoverCard.Dropdown>
    </HoverCard>
  );
}

export function SimilarImagesPreview({ imageId }: { imageId: number }) {
  const browsingLevel = useBrowsingLevelDebounced();
  const [minimum, setMinimum] = useState(85);
  const { data, isPending, isError, refetch } = trpc.semanticImageSearch.search.useQuery(
    {
      imageId,
      limit: 6,
      browsingLevel,
      minSimilarity: minimum / 100,
    },
    {
      staleTime: 60_000,
      retry: false,
      refetchOnWindowFocus: false,
      trpc: { context: { skipBatch: true }, abortOnUnmount: true },
    }
  );

  const similarityScores = data && 'similarityScores' in data ? data.similarityScores : undefined;

  return (
    <Stack gap="sm">
      <Text fw={600}>Similar images</Text>
      <Text size="xs" c="dimmed">
        Minimum similarity: {minimum}%
      </Text>
      <Slider
        thumbLabel="Minimum visual similarity"
        min={0}
        max={100}
        step={1}
        defaultValue={minimum}
        onChangeEnd={setMinimum}
        label={(value) => `${value}%`}
      />
      <Text size="xs" c="dimmed">
        Visual similarity score, not a probability of shared origin.
      </Text>
      {isError ? (
        <>
          <Text size="sm">Similar images are unavailable.</Text>
          <Button size="xs" variant="light" onClick={() => void refetch()}>
            Try again
          </Button>
        </>
      ) : isPending ? (
        <div
          className="flex h-24 items-center justify-center"
          role="status"
          aria-label="Finding similar images"
        >
          <Loader size="sm" />
        </div>
      ) : !data?.items.length ? (
        <Text size="sm" c="dimmed">
          No images meet this cutoff. Try lowering it.
        </Text>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          {data.items.map((item) => (
            <Anchor
              component={NextLink}
              href={`/images/${item.id}`}
              key={item.id}
              aria-label={`Open similar image ${item.id}`}
            >
              <ImageGuard2 image={item}>
                {(safe) => (
                  <div className="relative aspect-square overflow-hidden rounded bg-gray-8">
                    {safe ? (
                      <EdgeMedia
                        src={item.url}
                        width={180}
                        type={item.type}
                        anim={false}
                        className="size-full object-cover"
                        alt="Similar image"
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center text-xs text-gray-4">
                        Hidden
                      </div>
                    )}
                    {similarityScores?.[item.id] !== undefined && (
                      <span className="absolute bottom-1 right-1 rounded bg-black/75 px-1 text-xs text-white">
                        {Math.round(Math.min(1, Math.max(0, similarityScores[item.id])) * 100)}%
                      </span>
                    )}
                  </div>
                )}
              </ImageGuard2>
            </Anchor>
          ))}
        </div>
      )}
    </Stack>
  );
}
