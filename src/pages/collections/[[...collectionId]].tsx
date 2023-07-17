import {
  ActionIcon,
  Card,
  Drawer,
  Text,
  createStyles,
  Container,
  Button,
  Group,
} from '@mantine/core';
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
  resolver: async ({ ssg, session = null, features }) => {
    if (ssg) {
      if (session) {
        ssg.collection.getAllUser.prefetch({ permission: CollectionContributorPermission.VIEW });
      }
      // TODO - prefetch top user collections and popular collections
    }

    if (!features?.collections) return { notFound: true };
  },
});

export default function Collections() {
  const isMobile = useIsMobile();
  const { classes } = useStyle();
  const { collectionId } = useCollectionQueryParams();

  return (
    <Container fluid className={classes.container}>
      <Card
        className={classes.sidebar}
        withBorder
        w={220}
        mr="md"
        p="xs"
        mah="calc(80vh - var(--mantine-header-height,0))"
      >
        <Card.Section py={4} inheritPadding>
          <Text weight={500}>My Collections</Text>
        </Card.Section>
        {!isMobile && (
          <MyCollections>
            {({ FilterBox, Collections }) => (
              <>
                <Card.Section withBorder mb="xs">
                  {FilterBox}
                </Card.Section>
                {Collections}
              </>
            )}
          </MyCollections>
        )}
      </Card>
      <div className={classes.content}>
        {isMobile && <MyCollectionsDrawer />}
        {!collectionId ? <CollectionsLanding /> : <Collection collectionId={collectionId} fluid />}
      </div>
    </Container>
  );
}

function MyCollectionsDrawer() {
  const [drawerOpen, { close, toggle }] = useDisclosure();
  const { classes } = useStyleDrawer();

  return (
    <>
      <Button
        className={classes.drawerButton}
        onClick={toggle}
        mb="sm"
        pl={5}
        pr={8}
        variant="default"
      >
        <Group spacing={4}>
          <IconLayoutSidebarLeftExpand />
          My Collections
        </Group>
      </Button>
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
        <MyCollections onSelect={() => close()} />
      </Drawer>
    </>
  );
}

const useStyle = createStyles((theme) => ({
  container: {
    display: 'flex',
    flexWrap: 'nowrap',
    alignItems: 'flex-start',
  },
  sidebar: {
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
