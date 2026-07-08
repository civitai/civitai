import { AspectRatio, Box, Skeleton } from '@mantine/core';
import { useMemo } from 'react';
import { ArticleCard } from '~/components/Cards/ArticleCard';
import { ImageCard } from '~/components/Cards/ImageCard';
import { ModelCard } from '~/components/Cards/ModelCard';
import { PostCard } from '~/components/Cards/PostCard';
import { HomeBlockWrapper } from '~/components/HomeBlocks/HomeBlockWrapper';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { ImagesProvider } from '~/components/Image/Providers/ImagesProvider';
import { ReactionSettingsProvider } from '~/components/Reaction/ReactionSettingsProvider';
import { FeaturedCollectionHeader } from '~/components/HomeBlocks/FeaturedCollectionHeader';
import { contestCollectionReactionsHidden } from '~/components/Collections/collection.utils';
import classes from '~/components/HomeBlocks/HomeBlock.module.scss';
import type { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import type { PickedFeaturedCollection } from '~/server/services/home-block.service';
import { CollectionMode } from '~/shared/utils/prisma/enums';
import { shuffle } from '~/utils/array-helpers';
import { trpc } from '~/utils/trpc';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { shouldPrioritizeLcpImage } from '~/components/HomeBlocks/lcpImagePriority';

const ITEMS_PER_ROW = 7;

type Props = {
  homeBlockId: number;
  metadata: HomeBlockMetaSchema;
  /** Position of this block in the homepage stack; block 0 holds the above-the-fold LCP image. */
  index?: number;
};

export const FeaturedCollectionsHomeBlock = ({ homeBlockId, index }: Props) => {
  const { data: homeBlock, isLoading } = trpc.homeBlock.getHomeBlock.useQuery(
    { id: homeBlockId },
    { trpc: { context: { skipBatch: true } } }
  );

  const picks = homeBlock?.pickedCollections ?? [];

  if (!isLoading && picks.length === 0) return null;

  if (isLoading) {
    return (
      <HomeBlockWrapper py={32}>
        <FeaturedCollectionSection
          pick={{ collection: null, items: [], rows: 2, limit: 8 }}
          isLoading
        />
      </HomeBlockWrapper>
    );
  }

  return (
    <>
      {picks.map((pick, pickIndex) =>
        pick.collection ? (
          <HomeBlockWrapper key={pick.collection.id} py={32}>
            {/* Only the first section of the first home block is above the fold. */}
            <FeaturedCollectionSection pick={pick} aboveFold={index === 0 && pickIndex === 0} />
          </HomeBlockWrapper>
        ) : null
      )}
    </>
  );
};

type SectionProps = { aboveFold?: boolean } & (
  | { pick: PickedFeaturedCollection; isLoading?: false }
  | {
      pick: { collection: null; items: []; rows: number; limit: number };
      isLoading: true;
    }
);

function FeaturedCollectionSection({ pick, isLoading, aboveFold }: SectionProps) {
  const { collection, items: rawItems } = pick;
  const rows = pick.rows;
  const features = useFeatureFlags();

  const shuffled = useMemo(() => shuffle(rawItems ?? []), [rawItems]);
  const shuffledData = useMemo(() => shuffled.map((x: { data: unknown }) => x.data), [shuffled]);
  const firstType = (shuffled[0] as { type?: string } | undefined)?.type ?? 'image';
  const type = firstType as 'image' | 'model' | 'post' | 'article';

  const { loadingPreferences, items: filtered } = useApplyHiddenPreferences({
    type: `${type}s` as 'images' | 'models' | 'posts' | 'articles',
    data: shuffledData as any,
  });

  const items = useMemo(() => filtered.slice(0, ITEMS_PER_ROW * rows), [filtered, rows]);

  const title = collection?.name ?? 'Collection';
  const link = collection ? `/collections/${collection.id}` : '#';
  const curator = collection?.user ?? null;

  const Header =
    collection && !isLoading ? (
      <Box mb="md">
        <FeaturedCollectionHeader title={title} link={link} curator={curator} />
      </Box>
    ) : null;

  return (
    <div style={{ '--count': items.length, '--rows': rows } as React.CSSProperties}>
      <Box mb="md">{Header}</Box>
      {isLoading || loadingPreferences ? (
        <div className={classes.grid}>
          {Array.from({ length: ITEMS_PER_ROW * rows }).map((_, index) => (
            <AspectRatio ratio={7 / 9} key={index} className="m-2">
              <Skeleton width="100%" />
            </AspectRatio>
          ))}
        </div>
      ) : (
        <div className={classes.grid}>
          <ImagesProvider
            hideReactionCount={collection?.mode === CollectionMode.Contest}
            images={type === 'image' ? (items as any) : undefined}
          >
            <ReactionSettingsProvider
              settings={{
                hideReactionCount: collection?.mode === CollectionMode.Contest,
                hideReactions: collection ? contestCollectionReactionsHidden(collection) : false,
              }}
            >
              {(items as any[]).map((item: any, idx: number) => {
                const priority = shouldPrioritizeLcpImage({
                  enabled: features.lcpImagePriority,
                  isFirstBlock: !!aboveFold,
                  index: idx,
                });
                return (
                  <div key={item.id ?? idx} className="p-2">
                    {type === 'model' && (
                      <ModelCard data={item} forceInView priority={priority} />
                    )}
                    {type === 'image' && <ImageCard data={item} priority={priority} />}
                    {type === 'post' && <PostCard data={item} priority={priority} />}
                    {type === 'article' && <ArticleCard data={item} priority={priority} />}
                  </div>
                );
              })}
            </ReactionSettingsProvider>
          </ImagesProvider>
        </div>
      )}
    </div>
  );
}
