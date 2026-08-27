import { Group, Stack, Text } from '@mantine/core';
import { IconTrash } from '@tabler/icons-react';
import clsx from 'clsx';
import Link from 'next/link';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { useHubFollows } from '~/components/Hubs/FollowHubButton';
import { hubUrl } from '~/components/Hubs/hub.utils';

/**
 * The followed half of the rail, styled like the owned list above it. Renders
 * nothing at all when the viewer follows none — an empty section is a permanent
 * "Followed Hubs" heading over blank space for everyone who never follows anything.
 *
 * The list it reads is already filtered by what the viewer may open, so a hub whose
 * owner has made it Private again is simply absent here.
 */
export function FollowedHubsSection({ activeHubKey }: { activeHubKey?: string }) {
  const { followed, pending, unfollow } = useHubFollows();

  if (!followed.length) return null;

  return (
    <Stack gap={0}>
      <Group justify="space-between" wrap="nowrap" px="sm" py={6} gap="xs">
        <Text size="xs" fw={700} tt="uppercase" c="dimmed" lineClamp={1}>
          Followed Hubs
        </Text>
      </Group>

      <Stack gap={4} px="sm" pb="sm">
        {followed.map((hub) => (
          // The unfollow control is a SIBLING of the link, not a child of it: a
          // button inside an anchor is invalid markup, and the click would navigate
          // as well as unfollow.
          <div key={hub.id} className="group relative">
            <Link
              href={hubUrl(hub)}
              className={clsx(
                'block rounded-md py-1.5 pl-2 pr-9',
                hub.key === activeHubKey
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

            {/* Revealed on hover, and on keyboard focus as well — hover alone makes
                it reachable by pointer only. */}
            <LegacyActionIcon
              size="sm"
              variant="subtle"
              color="red"
              className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 focus:opacity-100 group-hover:opacity-100"
              aria-label={`Unfollow ${hub.name}`}
              disabled={pending}
              onClick={() => unfollow(hub.id)}
            >
              <IconTrash size={16} />
            </LegacyActionIcon>
          </div>
        ))}
      </Stack>
    </Stack>
  );
}
