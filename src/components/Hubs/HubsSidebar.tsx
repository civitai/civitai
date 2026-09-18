import { Button, Card, Divider, Group, Stack, Text, TextInput } from '@mantine/core';
import { IconPlus, IconSearch } from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState } from 'react';
import clsx from 'clsx';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { dialogStore } from '~/components/Dialog/dialogStore';
import HubUpsertModal from '~/components/Hubs/HubUpsertModal';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { FollowedHubsSection } from '~/components/Hubs/FollowedHubsSection';
import { describeHubSources, hubUrl } from '~/components/Hubs/hub.utils';
import { trpc } from '~/utils/trpc';

export function useHubNav() {
  const router = useRouter();
  const currentUser = useCurrentUser();

  // The route's `id` is the hub's ENCODED key, not the row's int — only the server
  // can turn it back.
  const activeHubKey = typeof router.query.id === 'string' ? router.query.id : undefined;

  const { data: hubs = [] } = trpc.userHub.getAll.useQuery(undefined, { enabled: !!currentUser });
  const { data: followed = [] } = trpc.userHub.getFollowed.useQuery(undefined, {
    enabled: !!currentUser,
  });

  return {
    activeHubKey,
    hubs,
    followed,
    // Nav with nothing to navigate is the confusing state: on /hubs, someone who has
    // made no hubs gets the explainer alone.
    showNav: !!activeHubKey || hubs.length > 0 || followed.length > 0,
    openCreate: () => dialogStore.trigger({ component: HubUpsertModal }),
  };
}

/**
 * The hub nav as AppLayout's LEFT column — a sibling of <main>, the way the profile
 * page mounts its sidebar. Inside the main column it would sit below the sub-nav and
 * inherit the page's own top spacing, which is what put a gap above it.
 */
export function HubsSidebar() {
  const { activeHubKey, showNav, openCreate } = useHubNav();
  if (!showNav) return null;

  return (
    <div className="scroll-area relative min-h-full w-[320px] border-r border-gray-3 bg-gray-0 @max-sm:hidden dark:border-dark-4 dark:bg-dark-6">
      <HubsSidebarContent activeHubKey={activeHubKey} onNewHub={openCreate} />
    </div>
  );
}

function SectionHeader({ label, right }: { label: React.ReactNode; right?: React.ReactNode }) {
  return (
    <Group justify="space-between" wrap="nowrap" px="sm" py={6} gap="xs">
      <Text size="xs" fw={700} tt="uppercase" c="dimmed" lineClamp={1}>
        {label}
      </Text>
      {right}
    </Group>
  );
}

/**
 * Hub switching, and nothing else. A hub's sources are edited in its own modal:
 * they belong to the hub rather than to the act of moving between hubs, and keeping
 * them here gave the mobile drawer two unrelated jobs.
 */
export function HubsSidebarContent({
  activeHubKey,
  onNewHub,
}: {
  activeHubKey?: string;
  onNewHub: () => void;
}) {
  const currentUser = useCurrentUser();
  const [search, setSearch] = useState('');

  const { data: hubs = [] } = trpc.userHub.getAll.useQuery(undefined, { enabled: !!currentUser });

  const term = search.trim().toLowerCase();
  const visible = term ? hubs.filter((hub) => hub.name.toLowerCase().includes(term)) : hubs;

  return (
    <Stack gap={0}>
      {/* `?all`, because /hubs sends someone with a single hub straight to it — this
          is how they reach the templates and the explainer. */}
      <Text component={Link} href="/hubs?all" fw={600} px="sm" py="xs">
        Civitai Hubs
      </Text>
      <Divider />

      {!!currentUser && (
        <>
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
                    href={hubUrl(hub)}
                    className={clsx(
                      'rounded-md px-2 py-1.5',
                      hub.key === activeHubKey
                        ? 'bg-gray-2 dark:bg-dark-5'
                        : 'hover:bg-gray-1 dark:hover:bg-dark-6'
                    )}
                  >
                    <Text size="sm" fw={700} lineClamp={1}>
                      {hub.name}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {describeHubSources(hub.sourceCounts)}
                    </Text>
                  </Link>
                ))}
              </Stack>
            )}
          </Stack>

          {/* Renders nothing until you follow something, so it costs an empty list no
              space and no heading. */}
          <FollowedHubsSection activeHubKey={activeHubKey} />
        </>
      )}
    </Stack>
  );
}
