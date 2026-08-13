import {
  Anchor,
  AspectRatio,
  Box,
  Button,
  Group,
  Popover,
  Skeleton,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { IconArrowRight, IconInfoCircle } from '@tabler/icons-react';
import { useMemo } from 'react';
import { ImageCard } from '~/components/Cards/ImageCard';
import { ModelCard } from '~/components/Cards/ModelCard';
import { HomeBlockWrapper } from '~/components/HomeBlocks/HomeBlockWrapper';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { ITEMS_PER_ROW, useCappedItems } from '~/components/HomeBlocks/homeBlockItems';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ImagesProvider } from '~/components/Image/Providers/ImagesProvider';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import type { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import type { FeedBlockItems } from '~/server/services/home-block.service';
import { shuffle } from '~/utils/array-helpers';
import { trpc } from '~/utils/trpc';
import classes from '~/components/HomeBlocks/HomeBlock.module.scss';

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
  const currentUser = useCurrentUser();
  const title = metadata.title ?? 'Feed';

  // Description lives in the info popover next to the title, matching Featured Models
  // and Featured Images. Signed-out visitors get it inline instead, since the header
  // is the only place that context can land for them.
  const header = (
    <Stack gap="sm">
      <Group gap="xs" justify="space-between" className={classes.header}>
        <Group wrap="nowrap">
          <Title className={classes.title} order={1} lineClamp={1}>
            {title}{' '}
          </Title>
          {currentUser && metadata.description && (
            <Popover withArrow width={380}>
              <Popover.Target>
                <Box
                  role="button"
                  tabIndex={0}
                  aria-label="About this section"
                  display="inline-block"
                  style={{ lineHeight: 0.3, cursor: 'pointer' }}
                  color="white"
                >
                  <IconInfoCircle size={20} />
                </Box>
              </Popover.Target>
              <Popover.Dropdown maw="100%">
                <Text fw={500} size="lg" mb="xs">
                  {title}
                </Text>
                <Text component="div" size="sm" mb="xs">
                  <CustomMarkdown allowedElements={['a']} unwrapDisallowed>
                    {metadata.description}
                  </CustomMarkdown>
                </Text>
                {metadata.link && (
                  <Link legacyBehavior href={metadata.link} passHref>
                    <Anchor size="sm">
                      <Group gap={4}>
                        <Text inherit>{metadata.linkText ?? 'View All'}</Text>
                        <IconArrowRight size={16} />
                      </Group>
                    </Anchor>
                  </Link>
                )}
              </Popover.Dropdown>
            </Popover>
          )}
        </Group>
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
      {metadata.description && !currentUser && (
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

/**
 * Rotate the fetched pool so the shelf isn't identical on every visit, matching how
 * Collection and Featured Models blocks behave.
 *
 * Copies before shuffling: `shuffle` sorts in place, and the array here belongs to the
 * React Query cache.
 */
function useShuffled<T>(items: T[]) {
  return useMemo(() => shuffle([...items]), [items]);
}

type GridProps<T> = { items: T; rows: number; maxPerUser?: number };

function ImageFeedGrid({
  items,
  rows,
  maxPerUser,
}: GridProps<Extract<FeedBlockItems, { entity: 'images' }>['items']>) {
  const rotated = useShuffled(items);
  const { loadingPreferences, items: filtered } = useApplyHiddenPreferences({
    type: 'images',
    data: rotated,
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
  const rotated = useShuffled(items);
  const { loadingPreferences, items: filtered } = useApplyHiddenPreferences({
    type: 'models',
    data: rotated,
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
