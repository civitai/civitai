import {
  Button,
  Card,
  Collapse,
  Container,
  Divider,
  Drawer,
  Group,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from '@mantine/core';
import {
  IconChevronDown,
  IconChevronRight,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconMenu2,
  IconPlus,
  IconSearch,
} from '@tabler/icons-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState } from 'react';
import clsx from 'clsx';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { useContainerSmallerThan } from '~/components/ContainerProvider/useContainerSmallerThan';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { dialogStore } from '~/components/Dialog/dialogStore';
import HubUpsertModal from '~/components/Hubs/HubUpsertModal';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { hubLimits } from '~/server/schema/user-hub.schema';
const HubSourcePanel = dynamic(
  () => import('~/components/Hubs/HubSourcePanel').then((m) => m.HubSourcePanel),
  { ssr: false }
);
import { trpc } from '~/utils/trpc';
import classes from './HubsLayout.module.scss';

function SectionHeader({
  label,
  right,
  onClick,
  expanded,
}: {
  label: React.ReactNode;
  right?: React.ReactNode;
  onClick?: () => void;
  expanded?: boolean;
}) {
  const content = (
    <Group gap={4} wrap="nowrap" className="min-w-0">
      {onClick &&
        (expanded ? (
          <IconChevronDown size={14} className="shrink-0" />
        ) : (
          <IconChevronRight size={14} className="shrink-0" />
        ))}
      <Text size="xs" fw={700} tt="uppercase" c="dimmed" lineClamp={1}>
        {label}
      </Text>
    </Group>
  );

  return (
    <Group justify="space-between" wrap="nowrap" px="sm" py={6} gap="xs">
      {onClick ? (
        <UnstyledButton
          className="min-w-0 flex-1"
          aria-expanded={expanded}
          onClick={onClick}
          type="button"
        >
          {content}
        </UnstyledButton>
      ) : (
        content
      )}
      {right}
    </Group>
  );
}

/**
 * The rail holds what belongs to the hub you are on — its sources — plus the
 * other hubs you can switch to. Sort and period deliberately live in the sub-nav
 * instead, where every other feed puts them.
 *
 * Followed hubs will join the list here when hub sharing lands; the layout does
 * not change when they do.
 */
function HubsSidebarContent({
  activeHubId,
  onNewHub,
}: {
  activeHubId?: number;
  onNewHub: () => void;
}) {
  const [search, setSearch] = useState('');
  const [sourcesOpen, setSourcesOpen] = useState(false);

  const { data: hubs = [] } = trpc.userHub.getAll.useQuery();

  // The sources belong to the hub you are on, so they live beside it rather than
  // above the feed — the position the 2026-08-19 meeting moved away from, because
  // a full-width source list "covers up like a third of your screen".
  const { data: activeHub } = trpc.userHub.getById.useQuery(
    { id: activeHubId as number },
    { enabled: !!activeHubId }
  );

  const term = search.trim().toLowerCase();
  const visible = term ? hubs.filter((hub) => hub.name.toLowerCase().includes(term)) : hubs;

  return (
    <Stack gap={0}>
      <Text fw={600} px="sm" py="xs">
        Civitai Hubs
      </Text>
      <Divider />

      {activeHubId && activeHub && (
        <>
          <SectionHeader
            label={`Sources for ${activeHub.name}`}
            expanded={sourcesOpen}
            onClick={() => setSourcesOpen((value) => !value)}
            right={
              <Text size="xs" c="dimmed" className="shrink-0">
                {activeHub.sources.length} / {hubLimits.sourcesPerHub}
              </Text>
            }
          />

          {/* Mounted only once opened, which is also what defers the panel's chunk:
              `dynamic` starts fetching as soon as the component renders, so
              rendering it collapsed would pull it on every hub load. */}
          <Collapse in={sourcesOpen}>
            {sourcesOpen && (
              <div className="px-3 pb-3">
                <HubSourcePanel
                  hubId={activeHub.id}
                  maxSources={hubLimits.sourcesPerHub}
                  sources={activeHub.sources.map(({ id: _id, ...source }) => source)}
                />
              </div>
            )}
          </Collapse>
          <Divider />
        </>
      )}

      <SectionHeader
        label="My Hubs"
        right={
          <LegacyActionIcon
            size="sm"
            variant="subtle"
            aria-label="New hub"
            onClick={onNewHub}
            className="shrink-0"
          >
            <IconPlus size={16} />
          </LegacyActionIcon>
        }
      />

      <Stack gap="xs" px="sm" pb="sm">
        {hubs.length > 3 && (
          <TextInput
            size="xs"
            placeholder="Search your hubs"
            leftSection={<IconSearch size={14} />}
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
          />
        )}

        {hubs.length === 0 ? (
          <Card withBorder p="sm" radius="md">
            <Stack gap="xs" align="flex-start">
              <Text size="xs" c="dimmed">
                You don&apos;t have any hubs yet. Create one and it shows up here.
              </Text>
              <Button size="compact-xs" leftSection={<IconPlus size={14} />} onClick={onNewHub}>
                Create a hub
              </Button>
            </Stack>
          </Card>
        ) : visible.length === 0 ? (
          <Text size="xs" c="dimmed">
            No hubs match that.
          </Text>
        ) : (
          <Stack gap={4}>
            {visible.map((hub) => (
              <Link
                key={hub.id}
                href={`/hubs/${hub.id}`}
                className={clsx(
                  'rounded-md px-2 py-1.5',
                  hub.id === activeHubId
                    ? 'bg-gray-2 dark:bg-dark-5'
                    : 'hover:bg-gray-1 dark:hover:bg-dark-6'
                )}
              >
                <Text size="sm" fw={700} lineClamp={1}>
                  {hub.name}
                </Text>
                <Text size="xs" c="dimmed">
                  {hub.sources.length === 0
                    ? 'No sources'
                    : `${hub.sources.length} source${hub.sources.length === 1 ? '' : 's'}`}
                </Text>
              </Link>
            ))}
          </Stack>
        )}
      </Stack>
    </Stack>
  );
}

export function HubsLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const isMobile = useContainerSmallerThan('sm');
  const [showSidebar, setShowSidebar] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const activeHubId = Number.isInteger(Number(router.query.id))
    ? Number(router.query.id)
    : undefined;

  const openCreate = () => {
    setDrawerOpen(false);
    dialogStore.trigger({ component: HubUpsertModal });
  };

  return (
    <Container fluid className={classes.container}>
      {!!currentUser && !isMobile && (
        <Card
          className={classes.sidebar}
          w={300}
          mr="xs"
          p={0}
          // No inline `overflow` here on purpose — see the note in the SCSS module.
          style={{ marginLeft: showSidebar ? 0 : 'calc(-300px - var(--mantine-spacing-xs))' }}
          withBorder
        >
          <LegacyActionIcon
            className={classes.sidebarToggle}
            aria-label={showSidebar ? 'Collapse hub sidebar' : 'Expand hub sidebar'}
            onClick={() => setShowSidebar((value) => !value)}
          >
            {showSidebar ? <IconLayoutSidebarLeftCollapse /> : <IconLayoutSidebarLeftExpand />}
          </LegacyActionIcon>
          {/* The height cap lives on the scroller, not the Card: capping the Card
              while it stays `overflow: visible` (which the toggle in the gutter
              needs) puts the overflow outside the border and past the viewport,
              with nothing to scroll it. */}
          <ScrollArea.Autosize mah="calc(100dvh - var(--header-height) - var(--footer-height) - 68px)">
            <HubsSidebarContent activeHubId={activeHubId} onNewHub={openCreate} />
          </ScrollArea.Autosize>
        </Card>
      )}

      <div className={classes.content}>
        {!!currentUser && isMobile && (
          <>
            <Button
              className={classes.drawerButton}
              variant="default"
              size="compact-sm"
              leftSection={<IconMenu2 size={16} />}
              onClick={() => setDrawerOpen(true)}
              mb="xs"
            >
              My hubs
            </Button>
            <Drawer
              opened={drawerOpen}
              onClose={() => setDrawerOpen(false)}
              size="100%"
              title="Civitai Hubs"
            >
              <HubsSidebarContent activeHubId={activeHubId} onNewHub={openCreate} />
            </Drawer>
          </>
        )}
        {/* The feed's MasonryProvider lives INSIDE the rail's content column, not
            around it. Measured from outside, it counts columns against the full
            viewport and hands MasonryContainer a `combinedWidth` wider than the
            column it renders in — which overflows the page and pushes the hub's
            context menu off-screen. */}
        <FeedLayout>{children}</FeedLayout>
      </div>
    </Container>
  );
}
