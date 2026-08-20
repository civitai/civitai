import {
  Button,
  Card,
  Collapse,
  Container,
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
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { useContainerSmallerThan } from '~/components/ContainerProvider/useContainerSmallerThan';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { showErrorNotification } from '~/utils/notifications';
import { hubLimits } from '~/server/schema/user-hub.schema';
// Loaded on demand: the panel pulls QuickSearchDropdown, which statically imports
// react-instantsearch and instantsearch.js — ~100KB gz that a feed route has no
// use for until you edit sources. AppHeader keeps AutocompleteSearch out of the
// shared bundle the same way.
const HubSourcePanel = dynamic(
  () => import('~/components/Hubs/HubSourcePanel').then((m) => m.HubSourcePanel),
  { ssr: false }
);
import { trpc } from '~/utils/trpc';
import classes from './HubsLayout.module.scss';

/**
 * The rail holds what belongs to the hub you are on — its sources — plus the
 * other hubs you can switch to. Sort and period deliberately live in the sub-nav
 * instead, where every other feed puts them.
 *
 * Followed hubs will join the list here when hub sharing lands; the layout does
 * not change when they do.
 */
function HubsSidebarContent({ activeHubId }: { activeHubId?: number }) {
  const router = useRouter();
  const utils = trpc.useUtils();
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

  const create = trpc.userHub.upsert.useMutation({
    onSuccess: async (hub) => {
      await utils.userHub.getAll.invalidate();
      await router.push(`/hubs/${hub.id}`);
    },
    onError: (error) =>
      showErrorNotification({ title: 'Could not create hub', error: new Error(error.message) }),
  });

  const term = search.trim().toLowerCase();
  const visible = term ? hubs.filter((hub) => hub.name.toLowerCase().includes(term)) : hubs;

  return (
    <Stack gap="xs" p="xs">
      <Group justify="space-between" wrap="nowrap">
        <Text fw={600}>My hubs</Text>
        <Button
          size="compact-xs"
          leftSection={<IconPlus size={14} />}
          loading={create.isPending}
          onClick={() => create.mutate({ name: 'New hub', sources: [] })}
        >
          New
        </Button>
      </Group>

      {hubs.length > 3 && (
        <TextInput
          size="xs"
          placeholder="Search your hubs"
          leftSection={<IconSearch size={14} />}
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
        />
      )}

      {activeHubId && activeHub && (
        <Card withBorder p="xs">
          <UnstyledButton
            className="w-full"
            aria-expanded={sourcesOpen}
            aria-label="Sources"
            onClick={() => setSourcesOpen((value) => !value)}
          >
            <Group justify="space-between" wrap="nowrap">
              <Group gap={4} wrap="nowrap">
                {sourcesOpen ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}
                <Text fw={600}>Sources</Text>
              </Group>
              <Text size="xs" c="dimmed">
                {activeHub.sources.length} / {hubLimits.sourcesPerHub}
              </Text>
            </Group>
          </UnstyledButton>

          {/* Mounted only once opened, which is also what defers the panel's chunk:
              `dynamic` starts fetching as soon as the component renders, so
              rendering it collapsed would pull instantsearch on every hub load. */}
          <Collapse in={sourcesOpen}>
            {sourcesOpen && (
              <div className="pt-2">
                <HubSourcePanel
                  hubId={activeHub.id}
                  name={activeHub.name}
                  maxSources={hubLimits.sourcesPerHub}
                  sources={activeHub.sources.map(({ id: _id, ...source }) => source)}
                />
              </div>
            )}
          </Collapse>
        </Card>
      )}

      {visible.length === 0 ? (
        <Text size="xs" c="dimmed">
          {hubs.length === 0 ? 'No hubs yet.' : 'No hubs match that.'}
        </Text>
      ) : (
        <Stack gap={2}>
          {visible.map((hub) => (
            <Link
              key={hub.id}
              href={`/hubs/${hub.id}`}
              className={
                hub.id === activeHubId
                  ? 'rounded bg-gray-2 px-2 py-1 font-semibold dark:bg-dark-5'
                  : 'rounded px-2 py-1 hover:bg-gray-1 dark:hover:bg-dark-6'
              }
            >
              <Text size="sm" lineClamp={1}>
                {hub.name}
              </Text>
            </Link>
          ))}
        </Stack>
      )}
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
            <HubsSidebarContent activeHubId={activeHubId} />
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
              title="My hubs"
            >
              <HubsSidebarContent activeHubId={activeHubId} />
            </Drawer>
          </>
        )}
        {children}
      </div>
    </Container>
  );
}
