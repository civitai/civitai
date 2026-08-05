import { AspectRatio, Box, Button, Group, Skeleton, Stack, Title } from '@mantine/core';
import { IconArrowRight } from '@tabler/icons-react';
import { useMemo } from 'react';
import { ImageCard } from '~/components/Cards/ImageCard';
import { ModelCard } from '~/components/Cards/ModelCard';
import { HomeBlockWrapper } from '~/components/HomeBlocks/HomeBlockWrapper';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { ImagesProvider } from '~/components/Image/Providers/ImagesProvider';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import type { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import type { FeedBlockItems } from '~/server/services/home-block.service';
import { trpc } from '~/utils/trpc';
import classes from '~/components/HomeBlocks/HomeBlock.module.scss';

const ITEMS_PER_ROW = 7;

type Props = { homeBlockId: number; metadata: HomeBlockMetaSchema };

export const FeedHomeBlock = (props: Props) => (
  <HomeBlockWrapper py={32}>
    <FeedHomeBlockContent {...props} />
  </HomeBlockWrapper>
);

/**
 * Renders a slice of an existing feed under the block's saved filters. Presentation
 * mirrors CollectionHomeBlock (same grid, rows and per-user cap) — the difference is
 * only where the items come from.
 */
const FeedHomeBlockContent = ({ homeBlockId, metadata }: Props) => {
  const { data: homeBlock, isLoading } = trpc.homeBlock.getHomeBlock.useQuery(
    { id: homeBlockId },
    { trpc: { context: { skipBatch: true } } }
  );

  const rows = metadata.feed?.rows ?? 2;
  const feedItems = homeBlock?.feedItems;

  const header = (
    <Stack gap="sm">
      <Group gap="xs" justify="space-between" className={classes.header}>
        <Title className={classes.title} order={1} lineClamp={1}>
          {metadata.title ?? 'Feed'}
        </Title>
        {metadata.link && (
          <Link legacyBehavior href={metadata.link} passHref>
            <Button
              className={classes.expandButton}
              component="a"
              variant="subtle"
              rightSection={<IconArrowRight size={16} />}
            >
              {metadata.linkText ?? 'View All'}
            </Button>
          </Link>
        )}
      </Group>
      {metadata.description && (
        <div className="text-base">
          <CustomMarkdown allowedElements={['a']} unwrapDisallowed>
            {metadata.description}
          </CustomMarkdown>
        </div>
      )}
    </Stack>
  );

  // Each entity gets its own grid component so hidden-preference filtering and the
  // card union stay concretely typed instead of being cast at the render site.
  const grid =
    isLoading || !feedItems ? (
      <FeedSkeleton rows={rows} />
    ) : feedItems.entity === 'images' ? (
      <ImageFeedGrid items={feedItems.items} rows={rows} maxPerUser={metadata.feed?.maxPerUser} />
    ) : (
      <ModelFeedGrid items={feedItems.items} rows={rows} maxPerUser={metadata.feed?.maxPerUser} />
    );

  return (
    <div style={{ '--rows': rows } as React.CSSProperties}>
      <Box mb="md">{header}</Box>
      {grid}
      {metadata.footer && (
        <Stack mt="md">
          <div className="mb-2 text-sm">
            <CustomMarkdown allowedElements={['a']} unwrapDisallowed>
              {metadata.footer}
            </CustomMarkdown>
          </div>
        </Stack>
      )}
    </div>
  );
};

const FeedSkeleton = ({ rows }: { rows: number }) => (
  <div className={classes.grid}>
    {Array.from({ length: ITEMS_PER_ROW * rows }).map((_, index) => (
      <AspectRatio ratio={7 / 9} key={index} className="m-2">
        <Skeleton width="100%" />
      </AspectRatio>
    ))}
  </div>
);

/** Trim to the visible slice, capping how many items one creator can contribute. */
function useCappedItems<T extends { id: number; user?: { id: number } }>(
  items: T[],
  rows: number,
  maxPerUser?: number
) {
  return useMemo(() => {
    const itemsToShow = ITEMS_PER_ROW * rows;
    if (!maxPerUser) return items.slice(0, itemsToShow);

    const perUserCount = new Map<number, number>();
    const capped: T[] = [];
    for (const item of items) {
      if (capped.length >= itemsToShow) break;
      const userId = item.user?.id;
      if (userId == null) {
        capped.push(item);
        continue;
      }
      const count = perUserCount.get(userId) ?? 0;
      if (count >= maxPerUser) continue;
      perUserCount.set(userId, count + 1);
      capped.push(item);
    }
    return capped;
  }, [items, rows, maxPerUser]);
}

type GridProps<T> = { items: T; rows: number; maxPerUser?: number };

function ImageFeedGrid({
  items,
  rows,
  maxPerUser,
}: GridProps<Extract<FeedBlockItems, { entity: 'images' }>['items']>) {
  const { loadingPreferences, items: filtered } = useApplyHiddenPreferences({
    type: 'images',
    data: items,
  });
  const visible = useCappedItems(filtered, rows, maxPerUser);

  if (loadingPreferences) return <FeedSkeleton rows={rows} />;

  return (
    <div className={classes.grid} style={{ '--count': visible.length } as React.CSSProperties}>
      <ImagesProvider images={visible}>
        {visible.map((item) => (
          <div key={item.id} className="p-2">
            <ImageCard data={item} />
          </div>
        ))}
      </ImagesProvider>
    </div>
  );
}

function ModelFeedGrid({
  items,
  rows,
  maxPerUser,
}: GridProps<Extract<FeedBlockItems, { entity: 'models' }>['items']>) {
  const { loadingPreferences, items: filtered } = useApplyHiddenPreferences({
    type: 'models',
    data: items,
  });
  const visible = useCappedItems(filtered, rows, maxPerUser);

  if (loadingPreferences) return <FeedSkeleton rows={rows} />;

  return (
    <div className={classes.grid} style={{ '--count': visible.length } as React.CSSProperties}>
      {visible.map((item) => (
        <div key={item.id} className="p-2">
          <ModelCard data={item} forceInView />
        </div>
      ))}
    </div>
  );
}
