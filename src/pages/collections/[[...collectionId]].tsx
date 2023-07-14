import { ActionIcon, Card, Drawer, Text, createStyles } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { CollectionContributorPermission } from '@prisma/client';
import { IconLayoutSidebarLeftExpand } from '@tabler/icons-react';
import { Collection } from '~/components/Collections/Collection';
import { CollectionsLanding } from '~/components/Collections/CollectionsLanding';
import { MyCollections } from '~/components/Collections/MyCollections';
import { useCollectionQueryParams } from '~/components/Collections/collection.utils';
import { useIsMobile } from '~/hooks/useIsMobile';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  resolver: async ({ ssg, ctx, session = null }) => {
    if (ssg) {
      if (session) {
        ssg.collection.getAllUser.prefetch({ permission: CollectionContributorPermission.VIEW });
      }
      // TODO - prefetch top user collections and popular collections
    }
  },
});

export default function Collections() {
  const isMobile = useIsMobile();
  const { classes } = useStyle();
  const { collectionId } = useCollectionQueryParams();

  return (
    <div className={classes.container}>
      <Card className={classes.sidebar} withBorder>
        {!isMobile && <MyCollections />}
      </Card>
      <div className={classes.content}>
        {isMobile && <MyCollectionsDrawer />}
        {!collectionId ? <CollectionsLanding /> : <Collection collectionId={collectionId} fluid />}
      </div>
    </div>
  );
}

function MyCollectionsDrawer() {
  const [drawerOpen, { close, toggle }] = useDisclosure();
  const { classes } = useStyleDrawer();

  return (
    <>
      <ActionIcon className={classes.drawerButton} size="md" variant="transparent" onClick={toggle}>
        <IconLayoutSidebarLeftExpand />
      </ActionIcon>
      <Drawer
        opened={drawerOpen}
        onClose={close}
        size="full"
        title={
          <Text size="lg" weight={500}>
            My Collections
          </Text>
        }
        classNames={{ header: classes.drawerHeader }}
      >
        <MyCollections />
      </Drawer>
    </>
  );
}

const useStyle = createStyles((theme) => ({
  container: {
    display: 'flex',
    flexWrap: 'nowrap',
  },
  sidebar: {
    // display: 'block',
    width: 300,
    padding: theme.spacing.xs,
    marginLeft: theme.spacing.md,
    // background: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[3],
    borderRadius: theme.radius.xs,
    [theme.fn.smallerThan('sm')]: {
      display: 'none',
    },
  },
  content: {
    flex: 1,
  },
}));

const useStyleDrawer = createStyles((theme) => ({
  sidebar: {
    display: 'block',
    [theme.fn.smallerThan('sm')]: {
      display: 'none',
    },
  },

  drawerButton: {
    display: 'none',
    [theme.fn.smallerThan('sm')]: {
      display: 'block',
    },
  },

  drawerHeader: {
    padding: theme.spacing.xs,
    marginBottom: 0,
    boxShadow: theme.shadows.sm,
  },
}));
