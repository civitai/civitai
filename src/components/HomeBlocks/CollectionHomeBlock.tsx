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
import { useIsMobile } from '~/hooks/useIsMobile';
import { CollectionHomeBlockSkeleton } from '~/components/HomeBlocks/CollectionHomeBlockSkeleton';
import { trpc } from '~/utils/trpc';
import { shuffle } from '~/utils/array-helpers';
import { useMasonryContainerContext } from '~/components/MasonryColumns/MasonryContainer';

const useStyles = createStyles<string, { count: number; columnCount: number }>(
  (theme, { count, columnCount }) => {
    return {
      title: {
        fontSize: 32,

        [theme.fn.smallerThan('sm')]: {
          fontSize: 28,
        },
      },

      grid: {
        display: 'grid',
        gridTemplateColumns: `repeat(${columnCount}, 1fr)`,
        columnGap: theme.spacing.md,
        gridTemplateRows: `repeat(2, auto)`,
        gridAutoRows: 0,
        overflow: 'hidden',
        marginTop: -theme.spacing.md,

        '& > *': {
          marginTop: theme.spacing.md,
        },

        [theme.fn.smallerThan('md')]: {
          gridAutoFlow: 'column',
          gridTemplateColumns: `repeat(${count / 2}, minmax(280px, 1fr) )`,
          gridTemplateRows: `repeat(2, auto)`,
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

      expandButton: {
        height: 34,
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

const CollectionHomeBlockContent = ({ homeBlockId }: Props) => {
  const { columnCount } = useMasonryContainerContext();
  const { data: homeBlock, isLoading } = trpc.homeBlock.getHomeBlock.useQuery({ id: homeBlockId });
  const { classes, cx } = useStyles({
    count: homeBlock?.collection?.items.length ?? 0,
    columnCount,
  });
  const currentUser = useCurrentUser();
  const isMobile = useIsMobile();

  const { collection } = homeBlock || {};
  const items = useMemo(() => shuffle(collection?.items ?? []).slice(0, 14), [collection?.items]);

  if (isLoading) {
    return <CollectionHomeBlockSkeleton />;
  }

  if (!homeBlock || !collection) {
    return null;
  }

  const { metadata } = homeBlock;
  const itemType = collection.items?.[0]?.type || 'model';
  const Icon = icons[itemType];

  const MetaDataTop = (
    <Stack spacing="sm">
      <Group spacing="xs" position="apart" noWrap>
        <Group>
          <Title className={classes.title} order={1} lineClamp={1}>
            {metadata.title ?? collection.name}{' '}
          </Title>
          {!metadata.descriptionAlwaysVisible && currentUser && metadata.description && (
            <Popover withArrow width={380} position={isMobile ? 'bottom' : 'right-start'}>
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
                  {metadata.title ?? collection.name}
                </Text>
                {metadata.description && (
                  <Text size="sm" mb="xs">
                    {metadata.description}
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
        <Text>{metadata.description}</Text>
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
          {metadata.title ?? collection.name}
        </Title>
      </Group>
      {metadata.description && <Text maw={520}>{metadata.description}</Text>}
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
        {useGrid && <div className={classes.gridMeta}>{MetaDataGrid}</div>}
        {items.map((item) => (
          <Fragment key={item.id}>
            {item.type === 'model' && <ModelCard data={item.data} />}
            {item.type === 'image' && <ImageCard data={item.data} collectionId={collection?.id} />}
            {item.type === 'post' && <PostCard data={item.data} />}
            {item.type === 'article' && <ArticleCard data={item.data} />}
          </Fragment>
        ))}
      </div>
    </>
  );
};

type Props = { homeBlockId: number };
