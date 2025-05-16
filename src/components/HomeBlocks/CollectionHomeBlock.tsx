import {
  Button,
  Group,
  Stack,
  Title,
  Text,
  ThemeIcon,
  Box,
  Popover,
  Anchor,
  AspectRatio,
  Skeleton,
} from '@mantine/core';
import { Fragment, useEffect, useMemo } from 'react';
import {
  IconArrowRight,
  IconCategory,
  IconFileText,
  IconInfoCircle,
  IconLayoutList,
  IconPhoto,
} from '@tabler/icons-react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { ImageCard } from '~/components/Cards/ImageCard';
import { ModelCard } from '~/components/Cards/ModelCard';
import { HomeBlockWrapper } from '~/components/HomeBlocks/HomeBlockWrapper';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { PostCard } from '~/components/Cards/PostCard';
import { ArticleCard } from '~/components/Cards/ArticleCard';
import { trpc } from '~/utils/trpc';
import { shuffle } from '~/utils/array-helpers';
import classes from '~/components/HomeBlocks/HomeBlock.module.scss';
import { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import { ReactionSettingsProvider } from '~/components/Reaction/ReactionSettingsProvider';
import { CollectionMode } from '~/shared/utils/prisma/enums';
import { ImagesProvider } from '~/components/Image/Providers/ImagesProvider';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { contestCollectionReactionsHidden } from '~/components/Collections/collection.utils';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import clsx from 'clsx';

const icons = {
  model: IconCategory,
  image: IconPhoto,
  post: IconLayoutList,
  article: IconFileText,
};

export const CollectionHomeBlock = ({ showAds, ...props }: Props) => {
  const features = useFeatureFlags();
  // No other easy way to hide the block if the feature is disabled
  if (props.metadata.link?.includes('/articles') && !features.articles) return null;

  return (
    <HomeBlockWrapper py={32}>
      <CollectionHomeBlockContent {...props} />
    </HomeBlockWrapper>
  );
};

const ITEMS_PER_ROW = 7;
const CollectionHomeBlockContent = ({ homeBlockId, metadata }: Props) => {
  const { data: homeBlock, isLoading } = trpc.homeBlock.getHomeBlock.useQuery(
    { id: homeBlockId },
    { trpc: { context: { skipBatch: true } } }
  );

  const rows = metadata.collection?.rows ?? 2;

  const currentUser = useCurrentUser();

  const { collection } = homeBlock ?? {};

  const shuffled = useMemo(() => {
    if (!collection?.items) return [];
    return shuffle(collection.items);
  }, [collection?.items]);

  const shuffledData = useMemo(() => shuffled.map((x) => x.data), [shuffled]);

  // TODO - find a different way to return collections so that the type isn't set on the individual item
  const type = shuffled[0]?.type ?? 'model';
  const { loadingPreferences, items: filtered } = useApplyHiddenPreferences({
    type: `${type}s`,
    data: shuffledData,
  });

  const items = useMemo(() => {
    const itemsToShow = ITEMS_PER_ROW * rows;
    return filtered.slice(0, itemsToShow);
  }, [filtered, rows]);

  // useEffect(() => console.log({ homeBlock, filtered, items }), [homeBlock, filtered, items]);

  // useEffect(() => console.log('items'), [items]);

  if (!metadata.link) metadata.link = `/collections/${collection?.id ?? metadata.collection?.id}`;
  const itemType = collection?.items?.[0]?.type || 'model';
  const Icon = icons[itemType];

  const MetaDataTop = (
    <Stack
      gap="sm"
      style={{
        '--count': items.length ?? 0,
        '--rows': rows,
      }}
    >
      <Group gap="xs" justify="space-between" className={classes.header}>
        <Group wrap="nowrap">
          <Title className={classes.title} order={1} lineClamp={1}>
            {metadata.title ?? collection?.name ?? 'Collection'}{' '}
          </Title>
          {!metadata.descriptionAlwaysVisible && currentUser && metadata.description && (
            <Popover withArrow width={380}>
              <Popover.Target>
                <Box
                  display="inline-block"
                  style={{ lineHeight: 0.3, cursor: 'pointer' }}
                  color="white"
                >
                  <IconInfoCircle size={20} />
                </Box>
              </Popover.Target>
              <Popover.Dropdown maw="100%">
                <Text weight={500} size="lg" mb="xs">
                  {metadata.title ?? collection?.name ?? 'Collection'}
                </Text>
                {metadata.description && (
                  <Text size="sm" mb="xs">
                    <CustomMarkdown allowedElements={['a']} unwrapDisallowed>
                      {metadata.description}
                    </CustomMarkdown>
                  </Text>
                )}
                {metadata.link && (
                  <Link legacyBehavior href={metadata.link} passHref>
                    <Anchor size="sm">
                      <Group gap={4}>
                        <Text inherit>{metadata.linkText ?? 'View All'} </Text>
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
              rightIcon={<IconArrowRight size={16} />}
            >
              {metadata.linkText ?? 'View All'}
            </Button>
          </Link>
        )}
      </Group>
      {metadata.description && (metadata.descriptionAlwaysVisible || !currentUser) && (
        <Text>
          <CustomMarkdown allowedElements={['a']} unwrapDisallowed>
            {metadata.description}
          </CustomMarkdown>
        </Text>
      )}
    </Stack>
  );

  const MetaDataGrid = (
    <Stack justify="center">
      <Group align="center">
        {metadata.withIcon && (
          <ThemeIcon size={50} variant="light" color="gray">
            <Icon />
          </ThemeIcon>
        )}
        <Title className={classes.title} order={1} lineClamp={1}>
          {metadata.title ?? collection?.name ?? 'Collection'}
        </Title>
      </Group>
      {metadata.description && (
        <Text maw={520}>
          <CustomMarkdown allowedElements={['a']} unwrapDisallowed>
            {metadata.description}
          </CustomMarkdown>
        </Text>
      )}
      {metadata.link && (
        <div>
          <Link legacyBehavior href={metadata.link} passHref>
            <Button
              size="md"
              component="a"
              variant="light"
              color="gray"
              rightIcon={<IconArrowRight size={16} />}
            >
              {metadata.linkText ?? 'View All'}
            </Button>
          </Link>
        </div>
      )}
    </Stack>
  );

  const useGrid =
    metadata.description &&
    !metadata.stackedHeader &&
    (!currentUser || metadata.descriptionAlwaysVisible);

  return (
    <>
      <Box mb="md" className={clsx({ [classes.meta]: useGrid })}>
        {MetaDataTop}
      </Box>
      {isLoading || loadingPreferences ? (
        <div className={classes.grid}>
          {useGrid && <div className={classes.gridMeta}>{MetaDataGrid}</div>}
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
                hideReactions: collection && contestCollectionReactionsHidden(collection),
              }}
            >
              {useGrid && <div className={classes.gridMeta}>{MetaDataGrid}</div>}
              {items.map((item) => (
                <div key={item.id} className="p-2">
                  {type === 'model' && <ModelCard data={item as any} forceInView />}
                  {type === 'image' && <ImageCard data={item as any} />}
                  {type === 'post' && <PostCard data={item as any} />}
                  {type === 'article' && <ArticleCard data={item as any} />}
                </div>
              ))}
            </ReactionSettingsProvider>
          </ImagesProvider>
        </div>
      )}

      {metadata.footer && (
        <Stack mt="md">
          <Text size="sm" mb="xs">
            <CustomMarkdown allowedElements={['a']} unwrapDisallowed>
              {metadata.footer}
            </CustomMarkdown>
          </Text>
        </Stack>
      )}
    </>
  );
};

type Props = { homeBlockId: number; metadata: HomeBlockMetaSchema; showAds?: boolean };
