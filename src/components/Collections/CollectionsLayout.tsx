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
  Stack,
  ScrollArea,
  Divider,
  ActionIcon,
  Tooltip,
} from '@mantine/core';
import { MyCollections } from '~/components/Collections/MyCollections';
import { useDisclosure } from '@mantine/hooks';
import {
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconPlus,
  IconSortAscending,
  IconSortDescending,
} from '@tabler/icons-react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { useContainerSmallerThan } from '~/components/ContainerProvider/useContainerSmallerThan';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useState } from 'react';
import dynamic from 'next/dynamic';

const CollectionEditModal = dynamic(() => import('~/components/Collections/CollectionEditModal'));

const useStyle = createStyles((theme) => ({
  container: {
    display: 'flex',
    flexWrap: 'nowrap',
    alignItems: 'flex-start',
  },
  sidebar: {
    [containerQuery.smallerThan('sm')]: {
      display: 'none',
    },
    transition: 'margin-left 500ms',
    overflow: 'visible',
  },
  sidebarToggle: {
    position: 'absolute',
    top: 0,
    right: -32,
  },
  content: {
    flex: 1,
  },
}));

const useStyleDrawer = createStyles((theme) => ({
  sidebar: {
    display: 'block',
    [containerQuery.smallerThan('sm')]: {
      display: 'none',
    },
  },
  drawerButton: {
    display: 'none',
    [containerQuery.smallerThan('sm')]: {
      display: 'block',
    },
  },
  drawerHeader: {
    padding: theme.spacing.xs,
    marginBottom: 0,
    boxShadow: theme.shadows.sm,
  },
}));

type SortOrder = 'asc' | 'desc';

const MyCollectionsDrawer = ({
  sortOrder,
  setSortOrder,
}: {
  sortOrder: SortOrder;
  setSortOrder: React.Dispatch<React.SetStateAction<SortOrder>>;
}) => {
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
        <Group gap={4}>
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
        <MyCollections onSelect={() => close()} sortOrder={sortOrder}>
          {({ FilterBox, Collections }) => (
            <Stack gap={4}>
              <Group gap="xs" wrap="nowrap" px="sm">
                <div style={{ flex: 1 }}>{FilterBox}</div>
                <Tooltip
                  label={sortOrder === 'asc' ? 'Sort Z-A' : 'Sort A-Z'}
                  position="top"
                  withArrow
                >
                  <ActionIcon
                    variant="light"
                    size="sm"
                    onClick={() => setSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'))}
                  >
                    {sortOrder === 'asc' ? (
                      <IconSortDescending size={18} />
                    ) : (
                      <IconSortAscending size={18} />
                    )}
                  </ActionIcon>
                </Tooltip>
              </Group>
              <Divider />
              <ScrollArea.Autosize maxHeight="calc(100vh - 93px)" px="sm">
                {Collections}
              </ScrollArea.Autosize>
            </Stack>
          )}
        </MyCollections>
      </Drawer>
    </>
  );
};

const CollectionsLayout = ({ children }: { children: React.ReactNode }) => {
  const isMobile = useContainerSmallerThan('sm');
  const currentUser = useCurrentUser();
  const { classes } = useStyle();
  const [showSidebar, setShowSidebar] = useState(true);
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc');

  return (
    <Container fluid className={classes.container}>
      {!!currentUser && (
        <Card
          className={classes.sidebar}
          withBorder
          w={250}
          mr="md"
          p="xs"
          style={{ marginLeft: showSidebar ? 0 : -250 - 16 }}
        >
          <Tooltip label="Toggle Sidebar" justify="flex-end" openDelay={500}>
            <ActionIcon
              onClick={() => setShowSidebar((val) => !val)}
              className={classes.sidebarToggle}
            >
              {!showSidebar ? <IconLayoutSidebarLeftExpand /> : <IconLayoutSidebarLeftCollapse />}
            </ActionIcon>
          </Tooltip>
          <Card.Section py="md" inheritPadding>
            <Group justify="space-between" wrap="nowrap">
              <Text weight={500}>My Collections</Text>
              <Button
                onClick={() => {
                  dialogStore.trigger({
                    component: CollectionEditModal,
                  });
                }}
                variant="subtle"
                size="compact-sm"
                rightIcon={<IconPlus size={14} />}
              >
                Create
              </Button>
            </Group>
          </Card.Section>
          {!isMobile && (
            <MyCollections sortOrder={sortOrder}>
              {({ FilterBox, Collections, isLoading }) => (
                <>
                  <Card.Section withBorder mb="xs" px="xs" py="xs">
                    <Group gap="xs" wrap="nowrap">
                      <div style={{ flex: 1 }}>{FilterBox}</div>
                      <Tooltip
                        label={sortOrder === 'asc' ? 'Sort Z-A' : 'Sort A-Z'}
                        position="top"
                        withArrow
                      >
                        <ActionIcon
                          variant="light"
                          size="sm"
                          onClick={() => setSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'))}
                        >
                          {sortOrder === 'asc' ? (
                            <IconSortDescending size={18} />
                          ) : (
                            <IconSortAscending size={18} />
                          )}
                        </ActionIcon>
                      </Tooltip>
                    </Group>
                  </Card.Section>
                  {isLoading && (
                    <Center>
                      <Loader variant="bars" />
                    </Center>
                  )}
                  <Card.Section ml={0}>
                    <ScrollArea.Autosize maxHeight="calc(80vh - var(--header-height,0))">
                      {Collections}
                    </ScrollArea.Autosize>
                  </Card.Section>
                </>
              )}
            </MyCollections>
          )}
        </Card>
      )}
      <div className={classes.content}>
        {!!currentUser && isMobile && (
          <MyCollectionsDrawer sortOrder={sortOrder} setSortOrder={setSortOrder} />
        )}
        {children}
      </div>
    </Container>
  );
};

export { CollectionsLayout };
