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
} from '@mantine/core';
import { Tooltip } from '~/components/MantineOverlays';
import { CollectionInvitesButton } from '~/components/Collections/CollectionCollaborators/CollectionInvitesButton';
import { MyCollections } from '~/components/Collections/MyCollections';
import { SUBNAV_STICKY_GAP, useSubnavBottom } from '~/hooks/useSubnavBottom';
import { useDisclosure } from '@mantine/hooks';
import {
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconPlus,
} from '@tabler/icons-react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useContainerSmallerThan } from '~/components/ContainerProvider/useContainerSmallerThan';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import classes from './CollectionsLayout.module.scss';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

const CollectionEditModal = dynamic(() => import('~/components/Collections/CollectionEditModal'));

const MyCollectionsDrawer = ({ autoOpen = false }: { autoOpen?: boolean }) => {
  const [drawerOpen, { open, close, toggle }] = useDisclosure();
  // Once per mount, so closing the drawer does not re-open it on the next render.
  const autoOpened = useRef(false);
  useEffect(() => {
    if (autoOpen && !autoOpened.current) {
      autoOpened.current = true;
      open();
    }
  }, [autoOpen]); // eslint-disable-line react-hooks/exhaustive-deps

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
          Collections
        </Group>
      </Button>
      <Drawer
        opened={drawerOpen}
        onClose={close}
        size="100%"
        title={
          <Group gap="xs" wrap="nowrap">
            <Text size="lg" fw={500}>
              Collections
            </Text>
            <CollectionInvitesButton />
          </Group>
        }
        classNames={{ header: classes.drawerHeader, body: 'px-0' }}
      >
        <MyCollections onSelect={() => close()}>
          {({ FilterBox, Filters, ListMenu, Collections, InviteList }) => (
            <Stack gap={4}>
              <Stack gap="xs" px="sm">
                {InviteList}
                <Group gap="xs" wrap="nowrap">
                  <div style={{ flex: 1 }}>{FilterBox}</div>
                  {ListMenu}
                </Group>
                {Filters}
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

const CollectionsLayout = ({
  children,
  autoOpenDrawer = false,
}: {
  children: React.ReactNode;
  /** Phone only: open the collections drawer when the page loads. */
  autoOpenDrawer?: boolean;
}) => {
  const isMobile = useContainerSmallerThan('sm');
  const currentUser = useCurrentUser();
  const [showSidebar, setShowSidebar] = useState(true);
  const subnavBottom = useSubnavBottom();

  return (
    <Container fluid className={classes.container}>
      {/* The mobile drawer has always checked this; the desktop card never did,
          so a signed-out visitor got an empty "Collections" panel. */}
      {!!currentUser && (
        <MyCollections>
          {({ FilterBox, Filters, ListMenu, Collections, InviteList, isLoading }) => (
            <Card
              className={classes.sidebar}
              // The list scrolls inside the page scroll area; without this the subnav's
              // hide-on-scroll counts it as the page scrolling and retracts the subnav.
              data-ignore-hide-on-scroll=""
              w={300}
              mr="xs"
              p={0}
              style={{
                // No overflow here: the toggle below is positioned in the gutter
                // (right: -32px) and an inline `overflow: hidden` would out-rank the
                // `overflow: visible` on .sidebar and clip it out of existence. The
                // list scrolls in its own ScrollArea, so the Card does not need to.
                marginLeft: showSidebar ? 0 : 'calc(-300px - var(--mantine-spacing-xs))',
                // ⚠️ Does NOT account for the adhesive ad, which is a later in-flow child of the
                // 100%-height `#__next` column and so shortens the scroll area without shortening
                // the viewport — the sidebar's last rows sit behind it for users who see ads.
                maxHeight: 'calc(100dvh - var(--header-height) - var(--footer-height) - 68px)',
                // Follows the subnav's real bottom edge rather than a fixed header offset: the
                // subnav hides by translating, so it keeps its layout box and a static `top`
                // strands the sidebar a subnav-height below where it should sit.
                top: subnavBottom + SUBNAV_STICKY_GAP,
              }}
              withBorder
            >
              <Tooltip label="Toggle Sidebar" position="right" openDelay={500}>
                <LegacyActionIcon
                  onClick={() => setShowSidebar((val) => !val)}
                  className={classes.sidebarToggle}
                >
                  {!showSidebar ? (
                    <IconLayoutSidebarLeftExpand />
                  ) : (
                    <IconLayoutSidebarLeftCollapse />
                  )}
                </LegacyActionIcon>
              </Tooltip>
              <Card.Section p="xs" mx={0} className="border-t-0" withBorder>
                <Group justify="space-between" wrap="nowrap">
                  <Text fw={500}>Collections</Text>
                  <Group gap={4} wrap="nowrap">
                    <CollectionInvitesButton />
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
                </Group>
              </Card.Section>

              {InviteList}

              <Card.Section p="xs" mx={0} withBorder>
                <Stack gap="xs">
                  <Group gap="xs" wrap="nowrap">
                    <div style={{ flex: 1 }}>{FilterBox}</div>
                    {ListMenu}
                  </Group>
                  {Filters}
                </Stack>
              </Card.Section>
              {isLoading && (
                <Center py="md">
                  <Loader type="bars" />
                </Center>
              )}
              <Card.Section className={classes.list} mx={0}>
                <ScrollArea
                  className={classes.listScroll}
                  classNames={{ viewport: classes.listViewport }}
                  pb="md"
                >
                  {Collections}
                </ScrollArea>
              </Card.Section>
            </Card>
          )}
        </MyCollections>
      )}
      <div className={classes.content}>
        {!!currentUser && isMobile && <MyCollectionsDrawer autoOpen={autoOpenDrawer} />}
        {children}
      </div>
    </Container>
  );
};

export { CollectionsLayout };
