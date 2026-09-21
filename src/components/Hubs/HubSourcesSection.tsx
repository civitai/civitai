import { Stack, Text, UnstyledButton } from '@mantine/core';
import { HubSourceCard } from '~/components/Hubs/HubSourceCard';
import {
  useClearHubExcludedSources,
  useHubExcludedSources,
  useToggleHubSource,
} from '~/components/Hubs/hub-session.store';
import { groupHubSources } from '~/components/Hubs/hub.utils';
import { hubSourceKey } from '~/server/schema/user-hub.schema';
import type { UserHubSourceType } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';

/**
 * What this hub collects, and a per-viewer mute for each of it.
 *
 * The mute is SESSION-ONLY and never reaches the owner's rows — the server takes it as
 * a subtraction from what the hub resolves to (`resolveHubSources`), which is why it is
 * safe to accept from a client at all: it can only ever narrow the feed in front of the
 * person who set it. Removing a source, and editing the list, stay in the hub's modal.
 *
 * Drawn with `HubSourceCard` — the same component the rail used before this branch — so
 * a tag AND-group still reads as one card with its members as badges.
 */
export function HubSourcesSection({ hubKey }: { hubKey: string }) {
  const { data: hub } = trpc.userHub.getById.useQuery({ key: hubKey }, { enabled: !!hubKey });
  const excluded = useHubExcludedSources(hub?.id ?? 0);
  const toggleSource = useToggleHubSource();
  const clearExcluded = useClearHubExcludedSources();

  // Only the positive ones. A hub's "never show" list is not something a viewer may
  // switch OFF — that is the one direction this control must not move the feed, and
  // the server refuses it regardless.
  const sources = (hub?.sources ?? []).filter((source) => !source.exclude);
  if (!hub || !sources.length) return null;

  const groups = groupHubSources(sources);
  const muted = new Set(excluded.map(hubSourceKey));
  // A group is one AND-set: muting any member drops the whole set server-side, so the
  // card switches as one unit too.
  const isMuted = (members: { type: UserHubSourceType; targetId: number }[]) =>
    members.some((source) => muted.has(hubSourceKey(source)));
  const mutedCount = groups.filter((group) => isMuted(group.sources)).length;

  return (
    <Stack gap="xs" px="sm" pb="sm">
      {groups.map((group) => {
        const [first, ...rest] = group.sources;
        return (
          <HubSourceCard
            key={group.key}
            source={{ ...first, enabled: !isMuted(group.sources) }}
            extraTags={rest}
            hideRemove
            // Keyed on ONE member even for a group — the server pulls the rest out with
            // it, and sending every member would say the same thing at the cost of the
            // cap on what a client may send.
            onToggle={() => toggleSource(hub.id, { type: first.type, targetId: first.targetId })}
            onRemove={() => undefined}
          />
        );
      })}

      {mutedCount > 0 && (
        <UnstyledButton onClick={() => clearExcluded(hub.id)} className="self-start">
          <Text size="xs" c="dimmed">
            {mutedCount} hidden, just for you —{' '}
            <Text span c="blue.5" fw={600} inherit>
              show all
            </Text>
          </Text>
        </UnstyledButton>
      )}
    </Stack>
  );
}
