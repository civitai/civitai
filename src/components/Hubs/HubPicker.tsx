import { Button, Text } from '@mantine/core';
import { IconLayoutGrid, IconPlus } from '@tabler/icons-react';
import clsx from 'clsx';
import Link from 'next/link';
import { useState } from 'react';
import { FilterButton } from '~/components/Buttons/FilterButton';
import { MobileMenuDrawer } from '~/components/Drawer/MobileMenuDrawer';
import { useHubNav } from '~/components/Hubs/HubsLayout';
import { describeHubSources, hubUrl } from '~/components/Hubs/hub.utils';
import type { UserHubSummary } from '~/server/services/user-hub.service';

function HubList({
  label,
  hubs,
  activeHubKey,
  onNavigate,
}: {
  label: string;
  hubs: UserHubSummary[];
  activeHubKey?: string;
  onNavigate: VoidFunction;
}) {
  if (!hubs.length) return null;

  return (
    <div className="flex flex-col gap-1">
      <Text size="xs" fw={700} tt="uppercase" c="dimmed" className="px-1 pt-2">
        {label}
      </Text>
      {hubs.map((hub) => (
        <Link
          key={hub.id}
          href={hubUrl(hub)}
          onClick={onNavigate}
          className={clsx(
            'rounded-md px-3 py-2',
            hub.key === activeHubKey
              ? 'bg-gray-2 dark:bg-dark-5'
              : 'hover:bg-gray-1 dark:hover:bg-dark-6'
          )}
        >
          <Text size="sm" fw={700} lineClamp={1}>
            {hub.name}
          </Text>
          <Text size="xs" c="dimmed" lineClamp={1}>
            {describeHubSources(hub.sourceCounts)}
          </Text>
        </Link>
      ))}
    </div>
  );
}

/**
 * Which hub you are looking at, as one control — a row of pills reads worse the more
 * hubs someone has, and cannot share a line with the feed's filters.
 *
 * The list is its own markup rather than `SelectMenuV2`'s options, because these are
 * LINKS in two named groups with a line of detail each, not values to pick from. What
 * is shared is the sheet they open in.
 */
export function HubPicker() {
  const { activeHubKey, hubs, followed, openCreate } = useHubNav();
  const [opened, setOpened] = useState(false);

  const active = [...hubs, ...followed].find((hub) => hub.key === activeHubKey);
  if (!hubs.length && !followed.length) return null;

  return (
    <>
      <FilterButton
        icon={IconLayoutGrid}
        active={opened}
        onClick={() => setOpened((open) => !open)}
      >
        {active?.name ?? 'Hubs'}
      </FilterButton>

      <MobileMenuDrawer
        opened={opened}
        onClose={() => setOpened(false)}
        title={<Text fw={600}>Hubs</Text>}
        closeButtonProps={{ 'aria-label': 'Close hub menu' }}
      >
        <div className="flex flex-col gap-2">
          <HubList
            label="My hubs"
            hubs={hubs}
            activeHubKey={activeHubKey}
            onNavigate={() => setOpened(false)}
          />
          <HubList
            label="Following"
            hubs={followed}
            activeHubKey={activeHubKey}
            onNavigate={() => setOpened(false)}
          />
          <Button
            variant="light"
            leftSection={<IconPlus size={16} />}
            className="mt-2"
            onClick={() => {
              setOpened(false);
              openCreate();
            }}
          >
            New hub
          </Button>
        </div>
      </MobileMenuDrawer>
    </>
  );
}
