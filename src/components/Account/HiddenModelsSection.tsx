import { Button, Loader, Text, TextInput } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconSearch, IconX } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { openUnhideAllModal } from '~/components/Account/openUnhideAllModal';
import { SettingsSection } from '~/components/Account/SettingsLayout';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { NextLink } from '~/components/NextLink/NextLink';
import {
  useClearHiddenPreferences,
  useHiddenPreferencesData,
  useToggleHiddenPreferences,
} from '~/hooks/hidden-preferences';
import { getDisplayName } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

export function HiddenModelsSection() {
  const [search, setSearch] = useState('');
  const [debouncedSearch] = useDebouncedValue(search.trim(), 300);

  const { hiddenModels } = useHiddenPreferencesData();
  const hiddenIds = useMemo(
    () => new Set(hiddenModels.filter((x) => x.hidden).map((x) => x.id)),
    [hiddenModels]
  );

  const { data, isLoading, isFetchingNextPage, hasNextPage, fetchNextPage } =
    trpc.hiddenPreferences.getHiddenModels.useInfiniteQuery(
      { query: debouncedSearch.length >= 2 ? debouncedSearch : undefined },
      { getNextPageParam: (lastPage) => lastPage.nextCursor, enabled: hiddenIds.size > 0 }
    );
  // Unhiding updates the hidden-preferences cache optimistically; filtering by it drops the
  // row at once instead of waiting on a refetch of every loaded page.
  const items = useMemo(
    () => data?.pages.flatMap((page) => page.items).filter((item) => hiddenIds.has(item.id)) ?? [],
    [data, hiddenIds]
  );

  const toggleHiddenMutation = useToggleHiddenPreferences();
  const clearHiddenMutation = useClearHiddenPreferences();

  const unhideAllButton = (
    <Button
      size="compact-sm"
      variant="default"
      disabled={!hiddenIds.size}
      loading={clearHiddenMutation.isPending}
      onClick={() =>
        openUnhideAllModal({
          noun: 'model',
          count: hiddenIds.size,
          onConfirm: () => clearHiddenMutation.mutateAsync({ kind: 'model' }),
        })
      }
    >
      Unhide all
    </Button>
  );

  return (
    <SettingsSection
      title="Hidden models"
      description="Hidden models are left out of search, feeds and model pages."
      action={unhideAllButton}
    >
      {hiddenIds.size === 0 ? (
        <Text size="sm" c="dimmed">
          {`You haven't hidden any models. Use "Hide this model" from a model's menu to add one.`}
        </Text>
      ) : (
        <div className="flex flex-col gap-3">
          <TextInput
            placeholder="Search hidden models"
            aria-label="Search hidden models"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            leftSection={<IconSearch size={14} />}
          />
          <Text size="xs" c="dimmed">
            {hiddenIds.size.toLocaleString()} hidden {hiddenIds.size === 1 ? 'model' : 'models'}
          </Text>
          {isLoading ? (
            <div className="flex justify-center py-4">
              <Loader size="sm" />
            </div>
          ) : items.length === 0 ? (
            <Text size="sm" c="dimmed">
              {debouncedSearch.length >= 2
                ? 'No hidden models match your search.'
                : 'The models you still have hidden have since been deleted. Unhide all clears them.'}
            </Text>
          ) : (
            <ul className="flex max-h-80 flex-col overflow-y-auto">
              {items.map((item) => (
                <li
                  key={item.id}
                  className="flex items-center justify-between gap-3 border-b border-gray-2 py-1.5 last:border-b-0 dark:border-dark-5"
                >
                  <div className="min-w-0">
                    {item.name ? (
                      <>
                        <Text
                          component={NextLink}
                          href={`/models/${item.id}`}
                          size="sm"
                          className="block truncate hover:underline"
                        >
                          {item.name}
                        </Text>
                        <Text size="xs" c="dimmed" className="truncate">
                          {item.type ? getDisplayName(item.type) : ''}
                          {item.username ? ` · by ${item.username}` : ''}
                        </Text>
                      </>
                    ) : (
                      <>
                        <Text size="sm" c="dimmed">
                          Unavailable model
                        </Text>
                        <Text size="xs" c="dimmed">
                          No longer published or not visible to you
                        </Text>
                      </>
                    )}
                  </div>
                  <LegacyActionIcon
                    size="sm"
                    variant="subtle"
                    color="gray"
                    aria-label={`Unhide ${item.name ?? 'unavailable model'}`}
                    onClick={() =>
                      toggleHiddenMutation.mutateAsync({
                        kind: 'model',
                        data: [{ id: item.id }],
                        hidden: false,
                      })
                    }
                  >
                    <IconX size={14} />
                  </LegacyActionIcon>
                </li>
              ))}
            </ul>
          )}
          {hasNextPage && (
            <Button
              size="compact-sm"
              variant="subtle"
              className="self-center"
              loading={isFetchingNextPage}
              onClick={() => fetchNextPage()}
            >
              Load more
            </Button>
          )}
        </div>
      )}
    </SettingsSection>
  );
}
