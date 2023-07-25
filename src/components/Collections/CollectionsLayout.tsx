import {
  Button,
  Card,
  Center,
  Container,
  createStyles,
  Drawer,
  Group,
  Loader,
  Text,
} from '@mantine/core';
import { MyCollections } from '~/components/Collections/MyCollections';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useDisclosure } from '@mantine/hooks';
import { IconLayoutSidebarLeftExpand } from '@tabler/icons-react';

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

const MyCollectionsDrawer = () => {
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
};

const CollectionsLayout = ({ children }: { children: React.ReactNode }) => {
  const isMobile = useIsMobile();
  const { classes } = useStyle();

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
            {({ FilterBox, Collections, isLoading }) => {
              return (
                <>
                  <Card.Section withBorder mb="xs">
                    {FilterBox}
                  </Card.Section>
                  {isLoading && (
                    <Center>
                      <Loader variant="bars" />
                    </Center>
                  )}
                  {Collections}
                </>
              );
            }}
          </MyCollections>
        )}
      </Card>
      <div className={classes.content}>
        {isMobile && <MyCollectionsDrawer />}
        {children}
      </div>
    </Container>
  );
};

export { CollectionsLayout };
