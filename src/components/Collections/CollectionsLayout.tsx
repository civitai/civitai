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
  Box,
  ActionIcon,
  Tooltip,
} from '@mantine/core';
import { MyCollections } from '~/components/Collections/MyCollections';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useDisclosure } from '@mantine/hooks';
import {
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconPlus,
} from '@tabler/icons-react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { useContainerSmallerThan } from '~/components/ContainerProvider/useContainerSmallerThan';
import { triggerRoutedDialog } from '~/components/Dialog/RoutedDialogProvider';
import { dialogs } from '~/components/Dialog/routed-dialog-registry';
import { dialogStore } from '~/components/Dialog/dialogStore';
import CollectionEditModal from '~/components/Collections/CollectionEditModal';
import { useState } from 'react';

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
        <MyCollections onSelect={() => close()}>
          {({ FilterBox, Collections }) => {
            return (
              <Stack spacing={4}>
                {FilterBox}
                <Divider />
                <ScrollArea.Autosize maxHeight="calc(100vh - 93px)" px="sm">
                  {Collections}
                </ScrollArea.Autosize>
              </Stack>
            );
          }}
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
          <Tooltip label="Toggle Sidebar" position="right" openDelay={500}>
            <ActionIcon
              onClick={() => setShowSidebar((val) => !val)}
              className={classes.sidebarToggle}
            >
              {!showSidebar ? <IconLayoutSidebarLeftExpand /> : <IconLayoutSidebarLeftCollapse />}
            </ActionIcon>
          </Tooltip>
          <Card.Section py="md" inheritPadding>
            <Group position="apart" noWrap>
              <Text weight={500}>My Collections</Text>
              <Button
                onClick={() => {
                  dialogStore.trigger({
                    component: CollectionEditModal,
                  });
                }}
                variant="subtle"
                size="sm"
                compact
                rightIcon={<IconPlus size={14} />}
              >
                Create
              </Button>
            </Group>
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
                    <Card.Section ml={0}>
                      <ScrollArea.Autosize maxHeight="calc(80vh - var(--mantine-header-height,0))">
                        {Collections}
                      </ScrollArea.Autosize>
                    </Card.Section>
                  </>
                );
              }}
            </MyCollections>
          )}
        </Card>
      )}
      <div className={classes.content}>
        {!!currentUser && isMobile && <MyCollectionsDrawer />}
        {children}
      </div>
    </Container>
  );
};

export { CollectionsLayout };
