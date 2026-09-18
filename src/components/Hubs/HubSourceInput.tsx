import { Badge, Loader, Text, TextInput, UnstyledButton } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconCheck, IconPlus, IconSearch } from '@tabler/icons-react';
import clsx from 'clsx';
import { useState } from 'react';
import type { HubSourceValue } from '~/components/Hubs/HubSourceEditor';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { hubSourceKindLabel, kindColor } from '~/components/Hubs/hub.utils';
import { abbreviateNumber } from '~/utils/number-helpers';
import type { HubTemplate } from '~/server/schema/user-hub.schema';
import { UserHubSourceType } from '~/shared/utils/prisma/enums';
import { parseCivitaiUrlSafe } from '~/utils/civitai-url';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

type Suggestion = {
  type: HubSourceValue['type'];
  targetId: number;
  alias: string;
  image?: string | null;
  profilePicture?: { url: string } | null;
  imageCount?: number | null;
};

// A face for a person, an initial for a thing. Both square up at the same size so the
// names in a mixed list still form a column.
function RowAvatar({ item }: { item: Suggestion }) {
  const url = item.profilePicture?.url ?? item.image;
  const person = item.type === 'User';

  if (url)
    return (
      <EdgeMedia
        src={url}
        width={96}
        className={clsx('size-6 shrink-0 object-cover', person ? 'rounded-full' : 'rounded')}
        alt=""
      />
    );

  return (
    <div
      className={clsx(
        'grid size-6 shrink-0 place-items-center bg-gray-3 text-[10px] font-bold uppercase text-gray-7 dark:bg-dark-4 dark:text-dark-0',
        person ? 'rounded-full' : 'rounded'
      )}
    >
      {item.alias.slice(0, 1)}
    </div>
  );
}

type Kind = 'all' | HubSourceValue['type'];

const kinds: { value: Kind; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: UserHubSourceType.User, label: 'Creators' },
  { value: UserHubSourceType.Model, label: 'Models' },
  { value: UserHubSourceType.Tag, label: 'Tags' },
];

// Named for what a person recognises, not for the query behind them. "Your models"
// is separate from bookmarks on purpose: a creator does not think of their own
// catalogue as something they saved.
const groupLabels: Record<HubTemplate, string> = {
  following: 'Creators you follow',
  'my-models': 'Your models',
  bookmarks: 'Models you bookmarked',
};

// What a group shows before you type. Enough to say what kind of thing belongs here;
// the rest is a search away, and at p90 568 follows a full list never was the answer.
const PREVIEW_ROWS = 5;

function Row({ item, added, onAdd }: { item: Suggestion; added: boolean; onAdd: VoidFunction }) {
  return (
    <UnstyledButton
      disabled={added}
      onClick={onAdd}
      className={clsx(
        'flex w-full items-center gap-2.5 px-3 py-2',
        added ? 'opacity-60' : 'hover:bg-gray-1 dark:hover:bg-dark-6'
      )}
    >
      {added ? (
        <IconCheck size={16} className="shrink-0 text-green-6" />
      ) : (
        <IconPlus size={16} className="shrink-0 text-gray-6 dark:text-dark-2" />
      )}
      <RowAvatar item={item} />
      <Text size="sm" lineClamp={1} className="min-w-0 flex-1 text-left">
        {item.alias}
      </Text>
      <Badge size="xs" variant="light" color={kindColor[item.type] ?? 'gray'} className="shrink-0">
        {hubSourceKindLabel(item.type)}
      </Badge>
      {typeof item.imageCount === 'number' && (
        <Text size="xs" c="dimmed" className="w-16 shrink-0 text-right">
          {abbreviateNumber(item.imageCount)} images
        </Text>
      )}
    </UnstyledButton>
  );
}

function Group({
  label,
  total,
  template,
  items,
  isAdded,
  onAdd,
  onAddMany,
  remaining,
}: {
  label: string;
  total?: number;
  template?: HubTemplate;
  items: Suggestion[];
  isAdded: (source: { type: HubSourceValue['type']; targetId: number }) => boolean;
  onAdd: (source: Suggestion) => void;
  onAddMany?: (sources: HubSourceValue[]) => void;
  remaining: number;
}) {
  const utils = trpc.useUtils();
  const [filling, setFilling] = useState(false);

  if (!items.length) return null;

  // The same gather a starting point uses, so "Add 50" here and the card on the
  // landing page cannot disagree about what they collect.
  const addMany = async () => {
    if (!template || !onAddMany) return;
    setFilling(true);
    try {
      const candidates = await utils.userHub.sourceCandidates.fetch({ template });
      onAddMany(candidates.sources);
    } catch (error) {
      showErrorNotification({ title: 'Could not add those', error: error as Error });
    } finally {
      setFilling(false);
    }
  };

  const bulkCount = Math.min(total ?? items.length, remaining);

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 px-3 pb-1 pt-2">
        <Text size="xs" fw={700} tt="uppercase" c="dimmed" lineClamp={1}>
          {label}
          {total ? ` · ${total}` : ''}
        </Text>
        {!!template && !!onAddMany && bulkCount > 0 && (
          <UnstyledButton
            onClick={addMany}
            disabled={filling}
            className="ml-auto shrink-0 text-xs font-semibold text-blue-5"
          >
            {filling ? 'Adding…' : `Add ${bulkCount}`}
          </UnstyledButton>
        )}
      </div>
      {items.slice(0, PREVIEW_ROWS).map((item) => (
        <Row
          key={`${item.type}-${item.targetId}`}
          item={item}
          added={isAdded(item)}
          onAdd={() => onAdd(item)}
        />
      ))}
      {!!total && total > items.slice(0, PREVIEW_ROWS).length && (
        <Text size="xs" c="dimmed" className="px-3 pb-2 pt-1">
          and {total - Math.min(items.length, PREVIEW_ROWS)} more — start typing to find them
        </Text>
      )}
    </div>
  );
}

/**
 * The one box, and what it can reach. Creators, models and tags in a single search,
 * a pasted link resolved in the same field, and — before anything is typed — the
 * things the person already has a relationship with, grouped and labelled.
 *
 * The kind chips FILTER; they are not a mode to choose first. That was the tabs, and
 * having to declare what sort of thing you were adding before you could add anything
 * is most of what made the old editor hard to follow.
 */
export function HubSourceInput({
  placeholder = 'Search creators, models and tags — or paste a link',
  isAdded,
  onAdd,
  onAddMany,
  remaining,
  disabled,
  autoFocus,
  showSuggestions,
}: {
  placeholder?: string;
  isAdded: (source: { type: HubSourceValue['type']; targetId: number }) => boolean;
  onAdd: (source: Suggestion) => void;
  onAddMany?: (sources: HubSourceValue[]) => void;
  remaining: number;
  disabled?: boolean;
  autoFocus?: boolean;
  /** The resting groups. Off for the keep-out box, which is not a browse surface. */
  showSuggestions?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<Kind>('all');
  const [debounced] = useDebouncedValue(query, 400);
  const term = debounced.trim();

  // A link is resolved rather than searched: it names one thing exactly, and the
  // search arms are scoped to what the viewer already follows and owns.
  const url = parseCivitaiUrlSafe(term) ? term : undefined;

  const search = trpc.userHub.searchSources.useQuery(
    { query: term },
    { enabled: !disabled && !url && term.length > 0 }
  );
  const resolved = trpc.userHub.resolveSource.useQuery(
    { url: url as string },
    { enabled: !disabled && !!url }
  );
  const groups = trpc.userHub.sourceGroups.useQuery(undefined, {
    enabled: !disabled && !!showSuggestions && !term,
  });

  const named = (items: (Omit<Suggestion, 'alias'> & { alias: string | null })[]) =>
    items
      .filter((item) => (kind === 'all' ? true : item.type === kind))
      .map((item) => ({ ...item, alias: item.alias ?? '' }));

  const results: Suggestion[] = url
    ? resolved.data
      ? named([resolved.data])
      : []
    : named(search.data ?? []);

  const loading = url ? resolved.isFetching : search.isFetching;
  const noMatch = !loading && !!term && !results.length;

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

      {!!showSuggestions && (
        <div className="flex flex-wrap gap-1.5">
          {kinds.map((option) => (
            <UnstyledButton
              key={option.value}
              onClick={() => setKind(option.value)}
              className={clsx(
                'rounded-full border px-3 py-1 text-xs font-semibold',
                kind === option.value
                  ? 'border-blue-6 bg-blue-6 text-white'
                  : 'border-gray-3 hover:bg-gray-1 dark:border-dark-4 dark:hover:bg-dark-6'
              )}
            >
              {option.label}
            </UnstyledButton>
          ))}
        </div>
      )}

      {(!!results.length || (!term && !!showSuggestions)) && (
        <div className="overflow-hidden rounded-md border border-gray-3 dark:border-dark-4">
          {term
            ? results.map((item) => (
                <Row
                  key={`${item.type}-${item.targetId}`}
                  item={item}
                  added={isAdded(item)}
                  onAdd={() => add(item)}
                />
              ))
            : (groups.data ?? []).map((group) => (
                <Group
                  key={group.template}
                  label={groupLabels[group.template]}
                  template={group.template}
                  total={group.total}
                  items={named(group.items)}
                  isAdded={isAdded}
                  onAdd={add}
                  onAddMany={onAddMany}
                  remaining={remaining}
                />
              ))}
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
