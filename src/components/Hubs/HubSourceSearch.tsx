import {
  Badge,
  Group,
  Loader,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconSearch } from '@tabler/icons-react';
import { useState } from 'react';
import type { HubSuggestionType } from '~/server/schema/user-hub.schema';
import { HUB_COLLECTION_SOURCES_ENABLED } from '~/server/schema/user-hub.schema';
import { UserHubSourceType } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';

type Suggestion = { type: UserHubSourceType; targetId: number; alias: string };

// Collections are listed but not selectable until the index attribute they are
// served by is live — `HUB_COLLECTION_SOURCES_ENABLED` gates the write path too,
// so an enabled tab would offer sources the server refuses.
const tabs = [
  { value: UserHubSourceType.User, label: 'Creators', scope: 'creators you follow' },
  { value: UserHubSourceType.Model, label: 'Models', scope: 'models you own or bookmarked' },
  {
    value: UserHubSourceType.Collection,
    label: 'Collections',
    scope: 'collections you follow',
    disabled: !HUB_COLLECTION_SOURCES_ENABLED,
  },
];

/**
 * One type at a time, over a bounded window of the viewer's own relationships —
 * see SUGGESTIONS_WINDOW in user-hub.service.ts.
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
  const [type, setType] = useState<HubSuggestionType>(UserHubSourceType.User);
  const [query, setQuery] = useState('');
  const [debounced] = useDebouncedValue(query, 300);

  const { data: suggestions = [], isFetching } = trpc.userHub.sourceSuggestions.useQuery({
    type,
    query: debounced || undefined,
  });

  const active = tabs.find((tab) => tab.value === type);

  return (
    <Stack gap="xs">
      <SegmentedControl
        fullWidth
        size="xs"
        value={type}
        disabled={disabled}
        data={tabs.map(({ value, label, disabled: itemDisabled }) => ({
          value,
          label,
          disabled: itemDisabled,
        }))}
        onChange={(value) => setType(value as HubSuggestionType)}
      />

      <TextInput
        size="xs"
        leftSection={<IconSearch size={14} />}
        rightSection={isFetching ? <Loader size={14} /> : undefined}
        placeholder={`Search ${active?.scope ?? 'your library'}`}
        value={query}
        disabled={disabled}
        onChange={(event) => setQuery(event.currentTarget.value)}
      />

      {suggestions.length === 0 ? (
        <Text size="xs" c="dimmed">
          {isFetching
            ? 'Looking…'
            : query
            ? `No ${active?.scope ?? 'matches'} match that. You can paste a link below instead.`
            : `Nothing in ${active?.scope ?? 'your library'} yet. Paste a link below instead.`}
        </Text>
      ) : (
        <Stack gap={2} mah={220} className="overflow-y-auto">
          {suggestions.map((item) => {
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
      )}
    </Stack>
  );
}
