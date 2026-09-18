import { Badge, Button, Loader, Text, TextInput, UnstyledButton } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconCheck, IconPlus, IconSearch, IconX } from '@tabler/icons-react';
import clsx from 'clsx';
import { useState } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import type { HubSourceValue } from '~/components/Hubs/HubSourceEditor';
import type { ProfileImage } from '~/server/selectors/image.selector';
import { hubSourceKindLabel, kindColor } from '~/components/Hubs/hub.utils';
import type { HubSourceScope, HubTemplate } from '~/server/schema/user-hub.schema';
import { parseCivitaiUrlSafe } from '~/utils/civitai-url';
import { abbreviateNumber } from '~/utils/number-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

type Suggestion = {
  type: HubSourceValue['type'];
  targetId: number;
  alias: string;
  image?: string | null;
  profilePicture?: ProfileImage | null;
  username?: string | null;
  deletedAt?: Date | null;
  imageCount?: number | null;
};

/**
 * The tabs, which are navigation rather than a filter: you choose what kind of thing
 * you are after, and the box beneath searches inside it. `template` is what a scope's
 * bulk action gathers — tags have none, because there is no "all of them" to add.
 */
const tabs: {
  scope: HubSourceScope;
  label: string;
  describes: string;
  template?: HubTemplate;
  empty: string;
  resting?: string;
}[] = [
  {
    scope: 'following',
    label: 'Creators',
    describes: 'creators you follow',
    template: 'following',
    empty: 'You are not following anyone yet.',
  },
  {
    scope: 'my-models',
    label: 'My models',
    describes: 'models you published',
    template: 'my-models',
    empty: 'You have no published models yet.',
  },
  {
    scope: 'bookmarks',
    label: 'Bookmarked',
    describes: 'models you bookmarked',
    template: 'bookmarks',
    empty: 'Nothing bookmarked yet.',
  },
  {
    scope: 'tags',
    label: 'Tags',
    describes: 'tags',
    empty: 'No tag matches that.',
    // Nothing of this viewer's to browse — only the site's biggest tags, and one of
    // those matched 1,920 of the last 2,000 images, so offering them as one-click
    // adds builds a hub that is the whole site.
    resting: 'Search for a tag — mecha, portraits, landscapes.',
  },
];

const PREVIEW_ROWS = 5;

// A face for a person, an initial for a thing. Both square up at the same size so the
// names in a list still form a column.
function RowAvatar({ item }: { item: Suggestion }) {
  // 🔴 A person goes through `UserAvatar`, which is the only place that decides whether
  // a face may be shown — the viewer's browsing level, a Blocked ingestion, a legacy
  // `blob:` url, a deleted account. Rendering `profilePicture.url` here instead looked
  // like four lines of CSS and was a second, permanently stale copy of that gate.
  if (item.type === 'User')
    return (
      <UserAvatar
        user={{
          id: item.targetId,
          username: item.username ?? item.alias,
          image: item.image,
          profilePicture: item.profilePicture,
          deletedAt: item.deletedAt,
        }}
        withUsername={false}
        withDecorations={false}
        withHoverCard={false}
        avatarSize={24}
      />
    );

  // No component owns a model or a tag the way `UserAvatar` owns a person, and one
  // call site does not justify inventing one.
  if (item.image)
    return (
      <EdgeMedia
        src={item.image}
        width={96}
        className="size-6 shrink-0 rounded object-cover"
        alt=""
      />
    );

  return (
    <div className="grid size-6 shrink-0 place-items-center rounded bg-gray-3 text-[10px] font-bold uppercase text-gray-7 dark:bg-dark-4 dark:text-dark-0">
      {item.alias.slice(0, 1)}
    </div>
  );
}

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

/**
 * What goes in a hub, chosen the way people look for things: pick the kind, then find
 * the one you mean.
 *
 * The search box searches WITHIN the selected tab. That is the trade this shape makes
 * — clearer scope in exchange for a search that can miss — so when a scoped search
 * comes up empty the server says where the matches were, and the empty state offers
 * the tab that has them. A pasted link ignores tabs entirely: it names one exact
 * thing, and making someone guess its drawer first would be absurd.
 */
export function HubSourceInput({
  isAdded,
  onAdd,
  onRemove,
  onAddMany,
  remaining,
  disabled,
  autoFocus,
  exclude,
}: {
  isAdded: (source: { type: HubSourceValue['type']; targetId: number }) => boolean;
  onAdd: (source: Suggestion) => void;
  onRemove: (source: { type: HubSourceValue['type']; targetId: number }) => void;
  onAddMany?: (sources: HubSourceValue[]) => void;
  remaining: number;
  disabled?: boolean;
  autoFocus?: boolean;
  /** The keep-out box: same search, no bulk actions — nobody keeps out 50 things. */
  exclude?: boolean;
}) {
  const utils = trpc.useUtils();
  const [scope, setScope] = useState<HubSourceScope>(exclude ? 'all' : 'following');
  const [query, setQuery] = useState('');
  const [debounced] = useDebouncedValue(query, 400);
  const [filling, setFilling] = useState(false);

  const term = debounced.trim();
  // Undefined in the keep-out box, which searches every scope at once. Falling back
  // to the first tab there put its name on the no-match line: "No match in Creators."
  // for a search that had just been run across all four.
  const tab = tabs.find((item) => item.scope === scope);

  // A link names one thing exactly, so it answers whatever tab you are on.
  const url = parseCivitaiUrlSafe(term) ? term : undefined;

  const scoped = trpc.userHub.sourceScope.useQuery(
    { scope, query: term },
    { enabled: !disabled && !url }
  );
  const resolved = trpc.userHub.resolveSource.useQuery(
    { url: url as string },
    { enabled: !disabled && !!url }
  );

  const named = (items: (Omit<Suggestion, 'alias'> & { alias: string | null })[]) =>
    items.map((item) => ({ ...item, alias: item.alias ?? '' }));

  const items: Suggestion[] = url
    ? resolved.data
      ? named([resolved.data])
      : []
    : named(scoped.data?.items ?? []);

  const total = scoped.data?.total ?? 0;
  const elsewhere = scoped.data?.elsewhere ?? [];
  const loading = url ? resolved.isFetching : scoped.isFetching;
  const bulkCount = Math.min(total, remaining);

  const add = (source: Suggestion) => {
    onAdd(source);
    setQuery('');
  };

  // The same gather a starting point uses, so "Add 50" here and the card on the
  // landing page cannot disagree about what they collect.
  const addMany = async () => {
    if (!tab?.template || !onAddMany) return;
    setFilling(true);
    try {
      const candidates = await utils.userHub.sourceCandidates.fetch({ template: tab.template });
      onAddMany(candidates.sources);
    } catch (error) {
      showErrorNotification({ title: 'Could not add those', error: error as Error });
    } finally {
      setFilling(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {/* No tabs in the keep-out box: it is one short list of things to hide, and a
          second copy of the picker's whole apparatus for it is noise. */}
      {!exclude && (
        <div className="flex flex-wrap gap-1.5">
          {tabs.map((option) => (
            <UnstyledButton
              key={option.scope}
              onClick={() => setScope(option.scope)}
              className={clsx(
                'rounded-full border px-3 py-1 text-xs font-semibold',
                scope === option.scope
                  ? 'border-blue-6 bg-blue-6 text-white'
                  : 'border-gray-3 hover:bg-gray-1 dark:border-dark-4 dark:hover:bg-dark-6'
              )}
            >
              {option.label}
            </UnstyledButton>
          ))}
        </div>
      )}

      <TextInput
        value={query}
        disabled={disabled}
        autoFocus={autoFocus}
        placeholder={
          exclude
            ? 'Search creators, models and tags to keep out — or paste a link'
            : `Search ${tab?.describes ?? 'sources'} — or paste a link`
        }
        leftSection={loading ? <Loader size={14} /> : <IconSearch size={16} />}
        onChange={(event) => setQuery(event.currentTarget.value)}
      />

      {(!exclude || !!term || !!url) && (
        <div className="overflow-hidden rounded-md border border-gray-3 dark:border-dark-4">
          {!url && !term && !!tab?.resting ? (
            <Text size="xs" c="dimmed" className="px-3 py-4">
              {tab?.resting}
            </Text>
          ) : (
            <>
              {!url && (
                <div className="flex items-center gap-2 bg-gray-1 px-3 py-1.5 dark:bg-dark-7">
                  <Text size="xs" c="dimmed" lineClamp={1}>
                    {term
                      ? `${items.length} ${items.length === 1 ? 'match' : 'matches'}`
                      : `Showing ${Math.min(items.length, PREVIEW_ROWS)} of ${abbreviateNumber(
                          total
                        )} ${tab?.describes ?? 'sources'}`}
                  </Text>
                  {!exclude && !!tab?.template && !!onAddMany && !term && bulkCount > 0 && (
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
              )}

              {items.slice(0, term || url ? undefined : PREVIEW_ROWS).map((item) => (
                <Row
                  key={`${item.type}-${item.targetId}`}
                  item={item}
                  added={isAdded(item)}
                  onToggle={() => (isAdded(item) ? onRemove(item) : add(item))}
                />
              ))}

              {!items.length && !loading && (
                <div className="flex flex-col gap-1 px-3 py-4">
                  <Text size="xs" c="dimmed">
                    {url
                      ? 'Not a link we recognise.'
                      : term
                      ? tab
                        ? `No match in ${tab.label}.`
                        : 'No match.'
                      : tab?.empty}
                  </Text>
                  {/* A scoped search that finds nothing cannot say why from the inside —
                    "wrong drawer" is invisible unless the other drawers are checked. */}
                  {elsewhere.map((match) => {
                    const other = tabs.find((item) => item.scope === match.scope);
                    if (!other) return null;
                    return (
                      <UnstyledButton
                        key={match.scope}
                        onClick={() => setScope(match.scope)}
                        className="text-xs font-semibold text-blue-5"
                      >
                        {match.count} in {other.label} →
                      </UnstyledButton>
                    );
                  })}
                </div>
              )}

              {!term && !url && total > Math.min(items.length, PREVIEW_ROWS) && (
                <Text size="xs" c="dimmed" className="px-3 pb-2 pt-1.5">
                  {abbreviateNumber(total - Math.min(items.length, PREVIEW_ROWS))} more — search to
                  find them
                </Text>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
