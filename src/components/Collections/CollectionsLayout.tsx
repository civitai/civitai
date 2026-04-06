import {
  Button,
  Card,
  Center,
  Container,
  Drawer,
  Group,
  Loader,
  Text,
  Stack,
  ScrollArea,
  Divider,
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
import { useContainerSmallerThan } from '~/components/ContainerProvider/useContainerSmallerThan';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useState } from 'react';
import dynamic from 'next/dynamic';
import classes from './CollectionsLayout.module.scss';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

const CollectionEditModal = dynamic(() => import('~/components/Collections/CollectionEditModal'));

type SortOrder = 'asc' | 'desc';

const MyCollectionsDrawer = ({
  sortOrder,
  setSortOrder,
}: {
  sortOrder: SortOrder;
  setSortOrder: React.Dispatch<React.SetStateAction<SortOrder>>;
}) => {
  const [drawerOpen, { close, toggle }] = useDisclosure();

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
        size="100%"
        title={
          <Text size="lg" fw={500}>
            My Collections
          </Text>
        }
        classNames={{ header: classes.drawerHeader, body: 'px-0' }}
      >
        <MyCollections onSelect={() => close()} sortOrder={sortOrder}>
          {({ FilterBox, TypeFilter, Collections }) => (
            <Stack gap={4}>
              <Stack gap="xs" px="sm">
                <Group gap="xs" wrap="nowrap">
                  <div style={{ flex: 1 }}>{FilterBox}</div>
                  <Tooltip
                    label={sortOrder === 'asc' ? 'Sort Z-A' : 'Sort A-Z'}
                    position="top"
                    withArrow
                  >
                    <LegacyActionIcon
                      variant="light"
                      size="sm"
                      onClick={() => setSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'))}
                    >
                      {sortOrder === 'asc' ? (
                        <IconSortDescending size={18} />
                      ) : (
                        <IconSortAscending size={18} />
                      )}
                    </LegacyActionIcon>
                  </Tooltip>
                </Group>
                {TypeFilter}
              </Stack>
              <Divider />
              <ScrollArea.Autosize mah="calc(100vh - 105px)">{Collections}</ScrollArea.Autosize>
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
  const [showSidebar, setShowSidebar] = useState(true);
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc');

  return (
    <Container fluid className={classes.container}>
      <MyCollections sortOrder={sortOrder}>
        {({ FilterBox, TypeFilter, Collections, isLoading }) => (
          <Card
            className={classes.sidebar}
            w={300}
            mr="xs"
            p={0}
            style={{
              overflow: 'hidden',
              marginLeft: showSidebar ? 0 : 'calc(-300px - var(--mantine-spacing-xs))',
              maxHeight: 'calc(100dvh - var(--header-height) - var(--footer-height) - 68px)',
            }}
            withBorder
          >
            <Tooltip label="Toggle Sidebar" position="right" openDelay={500}>
              <LegacyActionIcon
                onClick={() => setShowSidebar((val) => !val)}
                className={classes.sidebarToggle}
              >
                {!showSidebar ? <IconLayoutSidebarLeftExpand /> : <IconLayoutSidebarLeftCollapse />}
              </LegacyActionIcon>
            </Tooltip>
            <Card.Section p="xs" mx={0} className="border-t-0" withBorder>
              <Group justify="space-between" wrap="nowrap">
                <Text fw={500}>My Collections</Text>
                <Button
                  onClick={() => {
                    dialogStore.trigger({
                      component: CollectionEditModal,
                    });
                  }}
                  variant="subtle"
                  size="compact-sm"
                  rightSection={<IconPlus size={14} />}
                >
                  Create
                </Button>
              </Group>
            </Card.Section>

            <Card.Section p="xs" mx={0} withBorder>
              <Stack gap="xs">
                <Group gap="xs" wrap="nowrap">
                  <div style={{ flex: 1 }}>{FilterBox}</div>
                  <Tooltip
                    label={sortOrder === 'asc' ? 'Sort Z-A' : 'Sort A-Z'}
                    position="top"
                    withArrow
                  >
                    <LegacyActionIcon
                      variant="light"
                      size="sm"
                      onClick={() => setSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'))}
                    >
                      {sortOrder === 'asc' ? (
                        <IconSortDescending size={18} />
                      ) : (
                        <IconSortAscending size={18} />
                      )}
                    </LegacyActionIcon>
                  </Tooltip>
                </Group>
                {TypeFilter}
              </Stack>
            </Card.Section>
            {isLoading && (
              <Center>
                <Loader type="bars" />
              </Center>
            )}
            <Card.Section className="relative h-full" mx={0}>
              <ScrollArea.Autosize mah="calc(68vh - var(--header-height,0))" pb="md">
                {Collections}
              </ScrollArea.Autosize>
            </Card.Section>
          </Card>
        )}
      </MyCollections>
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
