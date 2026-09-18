import { Loader, Text, TextInput, UnstyledButton } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconSearch } from '@tabler/icons-react';
import clsx from 'clsx';
import { useState } from 'react';
import type { HubSourceValue } from '~/components/Hubs/HubSourceEditor';
import { hubSourceKindLabel } from '~/components/Hubs/hub.utils';
import { parseCivitaiUrlSafe } from '~/utils/civitai-url';
import { trpc } from '~/utils/trpc';

type Suggestion = { type: HubSourceValue['type']; targetId: number; alias: string };

/**
 * The one box: creators, models and tags in a single search, with a pasted link
 * resolved in the same field. It replaces a mode you switched on, three type tabs and
 * a separate URL input — none of which a person has to know about to say what they
 * want in their hub.
 */
export function HubSourceInput({
  placeholder = 'Search creators, models and tags — or paste a link',
  isAdded,
  onAdd,
  disabled,
  autoFocus,
}: {
  placeholder?: string;
  isAdded: (source: { type: HubSourceValue['type']; targetId: number }) => boolean;
  onAdd: (source: Suggestion) => void;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [debounced] = useDebouncedValue(query, 400);

  // A link is resolved rather than searched: it names one thing exactly, and the
  // search arms are scoped to what the viewer already follows and owns.
  const url = parseCivitaiUrlSafe(debounced.trim()) ? debounced.trim() : undefined;

  const search = trpc.userHub.searchSources.useQuery(
    { query: debounced },
    { enabled: !disabled && !url && debounced.trim().length > 0 }
  );
  const resolved = trpc.userHub.resolveSource.useQuery(
    { url: url as string },
    { enabled: !disabled && !!url }
  );

  const results: Suggestion[] = url
    ? resolved.data
      ? [{ ...resolved.data, alias: resolved.data.alias ?? '' }]
      : []
    : (search.data ?? []).map((item) => ({ ...item, alias: item.alias ?? '' }));

  const loading = url ? resolved.isFetching : search.isFetching;
  const noMatch = !loading && !!debounced.trim() && !results.length;

  const add = (source: Suggestion) => {
    onAdd(source);
    setQuery('');
  };

  return (
    <div className="flex flex-col gap-2">
      <TextInput
        value={query}
        disabled={disabled}
        autoFocus={autoFocus}
        placeholder={placeholder}
        leftSection={loading ? <Loader size={14} /> : <IconSearch size={16} />}
        onChange={(event) => setQuery(event.currentTarget.value)}
      />

      {!!results.length && (
        <div className="overflow-hidden rounded-md border border-gray-3 dark:border-dark-4">
          {results.map((item) => {
            const added = isAdded(item);
            return (
              <UnstyledButton
                key={`${item.type}-${item.targetId}`}
                disabled={added}
                onClick={() => add(item)}
                className={clsx(
                  'flex w-full items-center gap-2 border-b border-gray-3 px-3 py-2 last:border-b-0 dark:border-dark-4',
                  added ? 'opacity-60' : 'hover:bg-gray-1 dark:hover:bg-dark-6'
                )}
              >
                <Text size="sm" lineClamp={1} className="flex-1 text-left">
                  {item.alias}
                </Text>
                <Text size="xs" c="dimmed" className="shrink-0">
                  {added ? 'Added' : hubSourceKindLabel(item.type)}
                </Text>
              </UnstyledButton>
            );
          })}
        </div>
      )}

      {noMatch && (
        <Text size="xs" c="dimmed">
          {url
            ? 'Not a link we recognise. Try a creator, model, version or tag page.'
            : 'Nothing matches that. Paste a link to add something you do not follow.'}
        </Text>
      )}
    </div>
  );
}
