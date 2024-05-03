import {
  Button,
  Group,
  Stack,
  Title,
  createStyles,
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
import Link from 'next/link';
import { ImageCard } from '~/components/Cards/ImageCard';
import { ModelCard } from '~/components/Cards/ModelCard';
import { HomeBlockWrapper } from '~/components/HomeBlocks/HomeBlockWrapper';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { PostCard } from '~/components/Cards/PostCard';
import { ArticleCard } from '~/components/Cards/ArticleCard';
import { trpc } from '~/utils/trpc';
import { shuffle } from '~/utils/array-helpers';
import ReactMarkdown from 'react-markdown';
import { useHomeBlockStyles } from '~/components/HomeBlocks/HomeBlock.Styles';
import { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import { ReactionSettingsProvider } from '~/components/Reaction/ReactionSettingsProvider';
import { CollectionMode } from '@prisma/client';
import { ImagesProvider } from '~/components/Image/Providers/ImagesProvider';
import { useResizeObserver } from '~/hooks/useResizeObserver';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';

const useStyles = createStyles<string, { count: number; rows: number }>(
  (theme, { count, rows }) => {
    return {
      grid: {
        display: 'grid',
        gridTemplateColumns: `repeat(auto-fill, minmax(320px, 1fr))`,
        // gap: theme.spacing.md,
        gridTemplateRows: `repeat(${rows}, auto)`,
        gridAutoRows: 0,
        overflow: 'hidden',
        margin: -theme.spacing.md / 2,
        // marginTop: -theme.spacing.md,
        // paddingBottom: theme.spacing.md,

        '& > *': {
          margin: theme.spacing.md / 2,
        },

        [containerQuery.smallerThan('md')]: {
          gridAutoFlow: 'column',
          gridTemplateColumns: `repeat(${count / 2}, minmax(280px, 1fr) )`,
          gridTemplateRows: `repeat(${rows}, auto)`,
          scrollSnapType: 'x mandatory',
          overflowX: 'auto',
        },

        [containerQuery.smallerThan('sm')]: {
          gridAutoFlow: 'column',
          gridTemplateColumns: `repeat(${count}, 280px)`,
          gridTemplateRows: 'auto',
          scrollSnapType: 'x mandatory',
          overflowX: 'auto',
          marginRight: -theme.spacing.md,
          marginLeft: -theme.spacing.md,
          paddingLeft: theme.spacing.md,

          '& > *': {
            scrollSnapAlign: 'center',
          },
        },
      },

      meta: {
        display: 'none',
        [containerQuery.smallerThan('md')]: {
          display: 'block',
        },
      },

      gridMeta: {
        gridColumn: '1 / span 2',
        display: 'flex',
        flexDirection: 'column',

        '& > *': {
          flex: 1,
        },

        [containerQuery.smallerThan('md')]: {
          display: 'none',
        },
      },
    };
  }
);

const icons = {
  model: IconCategory,
  image: IconPhoto,
  post: IconLayoutList,
  article: IconFileText,
};

export const CollectionHomeBlock = ({ showAds, ...props }: Props) => {
  return (
    <HomeBlockWrapper py={32} showAds={showAds}>
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
  const { classes, cx } = useStyles({
    count: homeBlock?.collection?.items.length ?? 0,
    rows,
  });
  const { classes: homeBlockClasses } = useHomeBlockStyles();
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

  // useEffect(() => console.log('items'), [items]);

  if (!metadata.link) metadata.link = `/collections/${collection?.id ?? metadata.collection?.id}`;
  const itemType = collection?.items?.[0]?.type || 'model';
  const Icon = icons[itemType];

  const MetaDataTop = (
    <Stack spacing="sm">
      <Group spacing="xs" position="apart" className={homeBlockClasses.header}>
        <Group noWrap>
          <Title className={homeBlockClasses.title} order={1} lineClamp={1}>
            {metadata.title ?? collection?.name ?? 'Collection'}{' '}
          </Title>
          {!metadata.descriptionAlwaysVisible && currentUser && metadata.description && (
            <Popover withArrow width={380}>
              <Popover.Target>
                <Box
                  display="inline-block"
                  sx={{ lineHeight: 0.3, cursor: 'pointer' }}
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
                    <ReactMarkdown
                      allowedElements={['a']}
                      unwrapDisallowed
                      className="markdown-content"
                    >
                      {metadata.description}
                    </ReactMarkdown>
                  </Text>
                )}
                {metadata.link && (
                  <Link href={metadata.link} passHref>
                    <Anchor size="sm">
                      <Group spacing={4}>
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
          <Link href={metadata.link} passHref>
            <Button
              className={homeBlockClasses.expandButton}
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
          <ReactMarkdown allowedElements={['a']} unwrapDisallowed className="markdown-content">
            {metadata.description}
          </ReactMarkdown>
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
        <Title className={homeBlockClasses.title} order={1} lineClamp={1}>
          {metadata.title ?? collection?.name ?? 'Collection'}
        </Title>
      </Group>
      {metadata.description && (
        <Text maw={520}>
          <ReactMarkdown allowedElements={['a']} unwrapDisallowed className="markdown-content">
            {metadata.description}
          </ReactMarkdown>
        </Text>
      )}
      {metadata.link && (
        <div>
          <Link href={metadata.link} passHref>
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

  // const ref = useResizeObserver<HTMLDivElement>((entry) => {
  //   const children = [...entry.target.childNodes] as HTMLElement[];
  //   for (const child of children) {
  //     const elementStyle = getComputedStyle(child);
  //     const paddingTop = parseFloat(elementStyle.paddingTop ?? '0');
  //     const paddingBottom = parseFloat(elementStyle.paddingBottom ?? '0');

  //     const height = child.clientHeight - paddingTop - paddingBottom;
  //     if (height === 0) child.style.visibility = 'hidden';
  //     else child.style.removeProperty('visibility');
  //   }
  // });

  const useGrid =
    metadata.description &&
    !metadata.stackedHeader &&
    (!currentUser || metadata.descriptionAlwaysVisible);

  return (
    <>
      <Box mb="md" className={cx({ [classes.meta]: useGrid })}>
        {MetaDataTop}
      </Box>
      {isLoading || loadingPreferences ? (
        <div className={classes.grid}>
          {Array.from({ length: ITEMS_PER_ROW * rows }).map((_, index) => (
            <AspectRatio ratio={7 / 9} key={index}>
              <Skeleton width="100%" />
            </AspectRatio>
          ))}
        </div>
      ) : (
        <div className={classes.grid}>
          <ImagesProvider
            hideReactionCount={collection?.mode === CollectionMode.Contest}
            images={
              // items
              //   .map((x) => {
              //     if (x.type === 'image') return x.data;
              //     return null;
              //   })
              //   .filter(isDefined) as any
              type === 'image' ? (items as any) : undefined
            }
          >
            <ReactionSettingsProvider
              settings={{ hideReactionCount: collection?.mode === CollectionMode.Contest }}
            >
              {useGrid && <div className={classes.gridMeta}>{MetaDataGrid}</div>}
              {items.map((item) => (
                <Fragment key={item.id}>
                  {type === 'model' && <ModelCard data={item as any} forceInView />}
                  {type === 'image' && <ImageCard data={item as any} />}
                  {type === 'post' && <PostCard data={item as any} />}
                  {type === 'article' && <ArticleCard data={item as any} />}
                </Fragment>
              ))}
            </ReactionSettingsProvider>
          </ImagesProvider>
        </div>
      )}
    </>
  );
};

type Props = { homeBlockId: number; metadata: HomeBlockMetaSchema; showAds?: boolean };
