import {
  Button,
  Group,
  Stack,
  Title,
  createStyles,
  Text,
  ThemeIcon,
  Box,
  StackProps,
} from '@mantine/core';
import { Fragment } from 'react';
import {
  IconAlbum,
  IconArrowRight,
  IconCategory,
  IconLayoutList,
  IconPhoto,
} from '@tabler/icons-react';
import Link from 'next/link';
import { ImageCard } from '~/components/Cards/ImageCard';
import { ModelCard } from '~/components/Cards/ModelCard';
import { HomeBlockWrapper } from '~/components/HomeBlocks/HomeBlockWrapper';
import { HomeBlockGetAll } from '~/types/router';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { PostCard } from '~/components/Cards/PostCard';

const useStyles = createStyles<string, { count: number }>((theme, { count }) => {
  return {
    title: {
      fontSize: 32,

      [theme.fn.smallerThan('sm')]: {
        fontSize: 28,
      },
    },

    grid: {
      display: 'grid',
      gridTemplateColumns: 'repeat( auto-fit, minmax(280px, 1fr) )',
      columnGap: theme.spacing.md,
      paddingLeft: theme.spacing.md,
      paddingRight: theme.spacing.md,
      gridTemplateRows: `repeat(2, auto)`,
      gridAutoRows: 0,
      overflow: 'hidden',
      marginTop: -theme.spacing.md,

      '& > *': {
        marginTop: theme.spacing.md,
      },

      [theme.fn.smallerThan('sm')]: {
        gridAutoFlow: 'column',
        gridTemplateColumns: `repeat(${count}, 280px)`,
        gridTemplateRows: 'auto',
        scrollSnapType: 'x mandatory',
        overflowX: 'auto',

        '& > *': {
          scrollSnapAlign: 'center',
        },
      },
    },

    meta: {
      display: 'none',
      [theme.fn.smallerThan('sm')]: {
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

      [theme.fn.smallerThan('sm')]: {
        display: 'none',
      },
    },

    expandButton: {
      height: 34,
    },
  };
});

const icons = {
  model: IconCategory,
  image: IconPhoto,
  post: IconLayoutList,
  article: IconLayoutList,
};

export const CollectionHomeBlock = ({ homeBlock }: Props) => {
  const { classes, cx } = useStyles({ count: homeBlock.collection?.items.length ?? 0 });
  const currentUser = useCurrentUser();

  if (!homeBlock.collection) {
    return null;
  }

  const { metadata, collection } = homeBlock;

  const type = collection.items[0].type;
  const Icon = icons[type];

  const MetaData = currentUser ? (
    <Stack spacing="sm">
      <Group spacing="xs" position="apart" noWrap>
        <Title className={classes.title} order={1} lineClamp={1}>
          {metadata.title ?? collection.name}
        </Title>
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
      {metadata.description && metadata.alwaysShowDescription && (
        <Text>{metadata.description}</Text>
      )}
    </Stack>
  ) : (
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

  return (
    <HomeBlockWrapper py={32} px={0} bleedRight>
      <Box mb="md" px="md" className={cx({ [classes.meta]: !currentUser })}>
        {MetaData}
      </Box>
      <div className={classes.grid}>
        {!currentUser && <div className={classes.gridMeta}>{MetaData}</div>}
        {collection.items.map((item) => (
          <Fragment key={item.id}>
            {item.type === 'model' && <ModelCard data={item.data} />}
            {item.type === 'image' && <ImageCard data={item.data} collectionId={collection?.id} />}
            {item.type === 'post' && <PostCard data={item.data} />}
          </Fragment>
        ))}
      </div>
    </HomeBlockWrapper>
  );
};

type Props = { homeBlock: HomeBlockGetAll[number] };

// function RenderMetaData({metadata, ...stackProps}: {metadata: HomeBlockMetaSchema;} & StackProps) {

// }
