import { ActionIcon, Badge, Group, Stack, Switch, Text, Tooltip } from '@mantine/core';
import { IconTrash } from '@tabler/icons-react';
import { useState } from 'react';
import { QuickSearchDropdown } from '~/components/Search/QuickSearchDropdown';
import type { SearchIndexDataMap } from '~/components/Search/search.utils2';
import { showErrorNotification } from '~/utils/notifications';
import { UserHubSourceType } from '~/shared/utils/prisma/enums';
import { hubLimits } from '~/server/schema/user-hub.schema';
import { trpc } from '~/utils/trpc';

type HubSource = {
  type: UserHubSourceType;
  targetId: number;
  alias?: string | null;
  enabled: boolean;
  index: number;
};

const sourceLabels: Record<UserHubSourceType, string> = {
  [UserHubSourceType.User]: 'Creator',
  [UserHubSourceType.Model]: 'Model',
  [UserHubSourceType.ModelVersion]: 'Version',
  [UserHubSourceType.Collection]: 'Collection',
};

export function HubSourcePanel({
  hubId,
  sources,
  maxSources,
}: {
  hubId: number;
  sources: HubSource[];
  maxSources: number;
}) {
  const utils = trpc.useUtils();
  const [pending, setPending] = useState<HubSource[] | null>(null);
  const current = pending ?? sources;

  const upsert = trpc.userHub.upsert.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.userHub.getById.invalidate({ id: hubId }),
        utils.userHub.getAll.invalidate(),
      ]);
      // The feed is keyed on hubId, not on the source list, so it will not refetch
      // on its own when the sources behind it change.
      await utils.image.getInfinite.invalidate({ hubId });
      setPending(null);
    },
    onError: (error) => {
      // Roll the optimistic list back — leaving it applied would show a source the
      // server refused (a private or rating-capped collection) as if it were saved.
      setPending(null);
      showErrorNotification({ title: 'Could not save sources', error: new Error(error.message) });
    },
  });

  const save = (next: HubSource[]) => {
    setPending(next);
    upsert.mutate({ id: hubId, sources: next.map((s, index) => ({ ...s, index })) });
  };

  const addSource = (type: UserHubSourceType, targetId: number, rawAlias: string) => {
    // Match what the server stores, so the optimistic row is not a different
    // string from the one that comes back.
    const alias = rawAlias.trim().slice(0, hubLimits.aliasLength);
    if (current.some((s) => s.type === type && s.targetId === targetId)) return;
    if (current.length >= maxSources) {
      showErrorNotification({
        title: 'Hub is full',
        error: new Error(`A hub can hold at most ${maxSources} sources.`),
      });
      return;
    }
    save([...current, { type, targetId, alias, enabled: true, index: current.length }]);
  };

  return (
    <Stack gap="sm">
      <QuickSearchDropdown
        disableInitialSearch
        supportedIndexes={['users', 'models', 'collections']}
        startingIndex="users"
        dropdownItemLimit={25}
        disabled={upsert.isPending}
        placeholder="Add a creator, model or collection"
        onItemSelected={(entity, item) => {
          if (entity.entityType === 'User') {
            const user = item as SearchIndexDataMap['users'][number];
            addSource(UserHubSourceType.User, user.id, user.username ?? `User ${user.id}`);
          } else if (entity.entityType === 'Model') {
            const model = item as SearchIndexDataMap['models'][number];
            addSource(UserHubSourceType.Model, model.id, model.name);
          } else if (entity.entityType === 'Collection') {
            const collection = item as SearchIndexDataMap['collections'][number];
            addSource(UserHubSourceType.Collection, collection.id, collection.name);
          }
        }}
      />

      {current.length === 0 ? (
        <Text size="sm" c="dimmed">
          Nothing here yet. Search above to follow a creator, a model or a public collection.
        </Text>
      ) : (
        <Stack gap={4}>
          {current.map((source) => (
            <Group key={`${source.type}-${source.targetId}`} justify="space-between" wrap="nowrap">
              <Group gap="xs" wrap="nowrap" className="min-w-0">
                <Badge size="sm" variant="light">
                  {sourceLabels[source.type]}
                </Badge>
                <Text size="sm" lineClamp={1}>
                  {source.alias ?? `#${source.targetId}`}
                </Text>
              </Group>
              <Group gap="xs" wrap="nowrap">
                <Tooltip label={source.enabled ? 'Showing in this hub' : 'Hidden from this hub'}>
                  <Switch
                    size="xs"
                    checked={source.enabled}
                    disabled={upsert.isPending}
                    aria-label={`Toggle ${source.alias ?? source.targetId}`}
                    onChange={(event) =>
                      save(
                        current.map((s) =>
                          s.type === source.type && s.targetId === source.targetId
                            ? { ...s, enabled: event.currentTarget.checked }
                            : s
                        )
                      )
                    }
                  />
                </Tooltip>
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color="red"
                  disabled={upsert.isPending}
                  aria-label={`Remove ${source.alias ?? source.targetId}`}
                  onClick={() =>
                    save(
                      current.filter(
                        (s) => !(s.type === source.type && s.targetId === source.targetId)
                      )
                    )
                  }
                >
                  <IconTrash size={16} />
                </ActionIcon>
              </Group>
            </Group>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
