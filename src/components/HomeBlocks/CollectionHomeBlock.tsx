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
import { Fragment, useMemo } from 'react';
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
import { useHiddenPreferencesContext } from '~/providers/HiddenPreferencesProvider';
import { ImagesProvider } from '~/components/Image/Providers/ImagesProvider';
import { isDefined } from '~/utils/type-guards';

const useStyles = createStyles<string, { count: number; rows: number }>(
  (theme, { count, rows }) => {
    return {
      grid: {
        display: 'grid',
        gridTemplateColumns: `repeat(auto-fill, minmax(320px, 1fr))`,
        columnGap: theme.spacing.md,
        gridTemplateRows: `repeat(${rows}, auto)`,
        gridAutoRows: 0,
        overflow: 'hidden',
        marginTop: -theme.spacing.md,
        paddingBottom: theme.spacing.md,

        '& > *': {
          marginTop: theme.spacing.md,
        },

        [theme.fn.smallerThan('md')]: {
          gridAutoFlow: 'column',
          gridTemplateColumns: `repeat(${count / 2}, minmax(280px, 1fr) )`,
          gridTemplateRows: `repeat(${rows}, auto)`,
          scrollSnapType: 'x mandatory',
          overflowX: 'auto',
        },

        [theme.fn.smallerThan('sm')]: {
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
        [theme.fn.smallerThan('md')]: {
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

        [theme.fn.smallerThan('md')]: {
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

export const CollectionHomeBlock = ({ ...props }: Props) => {
  return (
    <HomeBlockWrapper py={32}>
      <CollectionHomeBlockContent {...props} />
    </HomeBlockWrapper>
  );
};

const ITEMS_PER_ROW = 7;
const CollectionHomeBlockContent = ({ homeBlockId, metadata }: Props) => {
  const { data: homeBlock, isLoading } = trpc.homeBlock.getHomeBlock.useQuery({ id: homeBlockId });
  const rows = metadata.collection?.rows ?? 2;
  const { classes, cx } = useStyles({
    count: homeBlock?.collection?.items.length ?? 0,
    rows,
  });
  const { classes: homeBlockClasses } = useHomeBlockStyles();
  const currentUser = useCurrentUser();
  const {
    models: hiddenModels,
    images: hiddenImages,
    users: hiddenUsers,
    isLoading: loadingPreferences,
  } = useHiddenPreferencesContext();

  const { collection } = homeBlock ?? {};
  const items = useMemo(() => {
    const itemsToShow = ITEMS_PER_ROW * rows;
    const usersShown = new Set();
    const filteredItems = shuffle(collection?.items ?? []).filter((item) => {
      if (loadingPreferences || !currentUser) return true;

      // TODO: A lot of improvement can be done here like checking images within the model, etc.
      switch (item.type) {
        case 'model':
          return !hiddenModels.get(item.data.id) && !hiddenUsers.get(item.data.user.id);
        case 'image':
          if (
            hiddenImages.get(item.data.id) ||
            hiddenUsers.get(item.data.user.id) ||
            usersShown.has(item.data.user.id)
          )
            return false;
          usersShown.add(item.data.user.id);
          return true;
        case 'post':
        case 'article':
        default:
          return !hiddenUsers.get(item.data.user.id);
      }
    });

    return filteredItems.slice(0, itemsToShow);
  }, [collection?.items, loadingPreferences, hiddenModels, hiddenImages, hiddenUsers, rows]);

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

  const useGrid =
    metadata.description &&
    !metadata.stackedHeader &&
    (!currentUser || metadata.descriptionAlwaysVisible);

  return (
    <>
      <Box mb="md" className={cx({ [classes.meta]: useGrid })}>
        {MetaDataTop}
      </Box>
      <div className={classes.grid}>
        <ImagesProvider
          hideReactionCount={collection?.mode === CollectionMode.Contest}
          images={items
            .map((x) => {
              if (x.type === 'image') return x.data;
              return null;
            })
            .filter(isDefined)}
        >
          <ReactionSettingsProvider
            settings={{ hideReactionCount: collection?.mode === CollectionMode.Contest }}
          >
            {useGrid && <div className={classes.gridMeta}>{MetaDataGrid}</div>}
            {isLoading || loadingPreferences
              ? Array.from({ length: ITEMS_PER_ROW * rows }).map((_, index) => (
                  <AspectRatio ratio={7 / 9} key={index}>
                    <Skeleton width="100%" />
                  </AspectRatio>
                ))
              : items.map((item) => (
                  <Fragment key={item.id}>
                    {item.type === 'model' && (
                      <ModelCard data={{ ...item.data, image: item.data.images[0] }} />
                    )}
                    {item.type === 'image' && <ImageCard data={item.data} />}
                    {item.type === 'post' && <PostCard data={item.data} />}
                    {item.type === 'article' && <ArticleCard data={item.data} />}
                  </Fragment>
                ))}
          </ReactionSettingsProvider>
        </ImagesProvider>
      </div>
    </>
  );
};

type Props = { homeBlockId: number; metadata: HomeBlockMetaSchema };
