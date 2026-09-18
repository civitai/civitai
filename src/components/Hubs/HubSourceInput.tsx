import { Badge, Button, Loader, Text, TextInput, UnstyledButton } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconCheck, IconPlus, IconSearch, IconX } from '@tabler/icons-react';
import clsx from 'clsx';
import { useState } from 'react';
import type { HubSourceValue } from '~/components/Hubs/HubSourceEditor';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { hubSourceKindLabel, kindColor } from '~/components/Hubs/hub.utils';
import { abbreviateNumber } from '~/utils/number-helpers';
import type { HubTemplate } from '~/server/schema/user-hub.schema';
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

// Named for what a person recognises, not for the query behind them. "My models" is
// separate from bookmarks on purpose: a creator does not think of their own catalogue
// as something they saved.
//
// Tags are deliberately NOT a tab. There is no list of yours to browse — only the
// site's biggest tags, and one of those matched 1,920 of the last 2,000 images, so a
// one-click list of them builds a hub that is the whole site. Tags are searchable.
const tabs: { template: HubTemplate; label: string; scope: string; reach?: string }[] = [
  {
    template: 'following',
    label: 'Creators',
    scope: 'creators you follow',
    reach: 'Someone you do not follow? Search for them above.',
  },
  { template: 'my-models', label: 'My models', scope: 'models you published' },
  {
    template: 'bookmarks',
    label: 'Bookmarked',
    scope: 'models you bookmarked',
    reach: 'Anything else? Search for it above.',
  },
];

const emptyTab: Record<HubTemplate, string> = {
  following: 'You are not following anyone yet — search for creators above.',
  'my-models': 'You have no published models yet.',
  bookmarks: 'Nothing bookmarked yet — search for models above.',
};

// What a group shows before you type. Enough to say what kind of thing belongs here;
// the rest is a search away, and at p90 568 follows a full list never was the answer.
const PREVIEW_ROWS = 5;

function Row({
  item,
  added,
  onToggle,
}: {
  item: Suggestion;
  added: boolean;
  onToggle: VoidFunction;
}) {
  return (
    <UnstyledButton
      onClick={onToggle}
      aria-pressed={added}
      title={added ? 'Remove from this hub' : 'Add to this hub'}
      className="group flex w-full items-center gap-2.5 px-3 py-2 hover:bg-gray-1 dark:hover:bg-dark-6"
    >
      {added ? (
        <>
          <IconCheck size={16} className="shrink-0 text-green-6 group-hover:hidden" />
          <IconX size={16} className="hidden shrink-0 text-red-6 group-hover:block" />
        </>
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
  scope,
  reach,
  total,
  template,
  items,
  isAdded,
  onAdd,
  onRemove,
  onAddMany,
  remaining,
}: {
  /** What this list IS — "creators you follow". A tab label cannot carry it. */
  scope: string;
  /** How to reach what the list does not hold. */
  reach?: string;
  total?: number;
  template?: HubTemplate;
  items: Suggestion[];
  isAdded: (source: { type: HubSourceValue['type']; targetId: number }) => boolean;
  onAdd: (source: Suggestion) => void;
  onRemove: (source: { type: HubSourceValue['type']; targetId: number }) => void;
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
    <div className="flex flex-col border-b border-gray-3 last:border-b-0 dark:border-dark-4">
      <div className="flex items-center gap-2 bg-gray-1 px-3 py-1.5 dark:bg-dark-7">
        <Text size="xs" c="dimmed" lineClamp={1}>
          Showing {Math.min(items.length, PREVIEW_ROWS)} of{' '}
          {abbreviateNumber(total ?? items.length)} {scope}
        </Text>
        {!!template && !!onAddMany && bulkCount > 0 && (
          <Button
            size="compact-xs"
            variant="subtle"
            className="ml-auto shrink-0"
            loading={filling}
            onClick={addMany}
          >
            Add {bulkCount}
          </Button>
        )}
      </div>
      {items.slice(0, PREVIEW_ROWS).map((item) => (
        <Row
          key={`${item.type}-${item.targetId}`}
          item={item}
          added={isAdded(item)}
          onToggle={() => (isAdded(item) ? onRemove(item) : onAdd(item))}
        />
      ))}
      <div className="flex flex-col gap-0.5 px-3 pb-2 pt-1.5">
        {!!total && total > items.slice(0, PREVIEW_ROWS).length && (
          <Text size="xs" c="dimmed">
            {abbreviateNumber(total - Math.min(items.length, PREVIEW_ROWS))} more of yours — start
            typing to find them
          </Text>
        )}
        {!!reach && (
          <Text size="xs" c="dimmed">
            {reach}
          </Text>
        )}
      </div>
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
  onRemove,
  onAddMany,
  remaining,
  disabled,
  autoFocus,
  showSuggestions,
}: {
  placeholder?: string;
  isAdded: (source: { type: HubSourceValue['type']; targetId: number }) => boolean;
  onAdd: (source: Suggestion) => void;
  onRemove: (source: { type: HubSourceValue['type']; targetId: number }) => void;
  onAddMany?: (sources: HubSourceValue[]) => void;
  remaining: number;
  disabled?: boolean;
  autoFocus?: boolean;
  /** The resting groups. Off for the keep-out box, which is not a browse surface. */
  showSuggestions?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<HubTemplate>('following');
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
    items.map((item) => ({ ...item, alias: item.alias ?? '' }));

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

      {!!results.length && (
        <div className="overflow-hidden rounded-md border border-gray-3 dark:border-dark-4">
          {results.map((item) => (
            <Row
              key={`${item.type}-${item.targetId}`}
              item={item}
              added={isAdded(item)}
              onToggle={() => (isAdded(item) ? onRemove(item) : add(item))}
            />
          ))}
        </div>
      )}

      {!term && !!showSuggestions && (
        <div className="flex flex-col gap-2">
          {/* A shelf, not a mode: the search box above covers every kind whatever is
              selected here, which is what the old type tabs got wrong. */}
          <div className="flex flex-wrap gap-1.5">
            {tabs.map((option) => {
              const group = groups.data?.find((item) => item.template === option.template);
              return (
                <UnstyledButton
                  key={option.template}
                  onClick={() => setTab(option.template)}
                  className={clsx(
                    'flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold',
                    tab === option.template
                      ? 'border-blue-6 bg-blue-6 text-white'
                      : 'border-gray-3 hover:bg-gray-1 dark:border-dark-4 dark:hover:bg-dark-6'
                  )}
                >
                  {option.label}
                  {!!group?.total && (
                    <span className={tab === option.template ? 'opacity-80' : 'opacity-60'}>
                      {abbreviateNumber(group.total)}
                    </span>
                  )}
                </UnstyledButton>
              );
            })}
          </div>

          <div className="overflow-hidden rounded-md border border-gray-3 dark:border-dark-4">
            {groups.isLoading ? (
              <div className="flex items-center gap-2 px-3 py-4">
                <Loader size="xs" />
                <Text size="xs" c="dimmed">
                  Loading…
                </Text>
              </div>
            ) : (
              (() => {
                const group = groups.data?.find((item) => item.template === tab);
                if (!group?.items.length)
                  return (
                    <Text size="xs" c="dimmed" className="px-3 py-4">
                      {emptyTab[tab]}
                    </Text>
                  );

                const meta = tabs.find((item) => item.template === tab);
                return (
                  <Group
                    scope={meta?.scope ?? ''}
                    reach={meta?.reach}
                    template={group.template}
                    total={group.total}
                    items={named(group.items)}
                    isAdded={isAdded}
                    onAdd={add}
                    onRemove={onRemove}
                    onAddMany={onAddMany}
                    remaining={remaining}
                  />
                );
              })()
            )}
          </div>
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
