import { Badge, Group, Loader, Stack, Text, TextInput, UnstyledButton } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconSearch } from '@tabler/icons-react';
import { useState } from 'react';
import type { UserHubSourceType } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';

type Suggestion = { type: UserHubSourceType; targetId: number; alias: string };

/**
 * Scoped to what the viewer already has a relationship with — creators they
 * follow, models they own or have notifications on or bookmarked, collections
 * they follow — rather than searching the whole site. Anything outside that set
 * is added by pasting its link.
 */
export function HubSourceSearch({
  onSelect,
  isAdded,
  disabled,
}: {
  onSelect: (suggestion: Suggestion) => void;
  isAdded: (suggestion: Suggestion) => boolean;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [debounced] = useDebouncedValue(query, 300);

  const { data, isFetching } = trpc.userHub.sourceSuggestions.useQuery({
    query: debounced || undefined,
  });

  const groups = [
    { label: 'Creators you follow', items: data?.users ?? [] },
    { label: 'Your models & bookmarks', items: data?.models ?? [] },
    { label: 'Collections you follow', items: data?.collections ?? [] },
  ].filter((group) => group.items.length);

  return (
    <Stack gap="xs">
      <TextInput
        size="xs"
        leftSection={<IconSearch size={14} />}
        rightSection={isFetching ? <Loader size={14} /> : undefined}
        placeholder="Search creators you follow, your models, your bookmarks"
        value={query}
        disabled={disabled}
        onChange={(event) => setQuery(event.currentTarget.value)}
      />

      {groups.length === 0 ? (
        <Text size="xs" c="dimmed">
          {isFetching
            ? 'Looking…'
            : 'Nothing here matches. Follow a creator, bookmark a model, or paste a link below.'}
        </Text>
      ) : (
        <Stack gap={6} mah={220} className="overflow-y-auto">
          {groups.map((group) => (
            <Stack key={group.label} gap={2}>
              <Text size="xs" fw={700} tt="uppercase" c="dimmed">
                {group.label}
              </Text>
              {group.items.map((item) => {
                const added = isAdded(item);
                return (
                  <UnstyledButton
                    key={`${item.type}-${item.targetId}`}
                    disabled={disabled || added}
                    onClick={() => onSelect(item)}
                    className="rounded px-2 py-1 hover:bg-gray-1 disabled:opacity-50 dark:hover:bg-dark-5"
                  >
                    <Group justify="space-between" wrap="nowrap" gap="xs">
                      <Text size="sm" lineClamp={1}>
                        {item.alias}
                      </Text>
                      {added && (
                        <Badge size="xs" variant="light" className="shrink-0">
                          Added
                        </Badge>
                      )}
                    </Group>
                  </UnstyledButton>
                );
              })}
            </Stack>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
