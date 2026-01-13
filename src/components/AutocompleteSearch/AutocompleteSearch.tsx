import type { AutocompleteProps, ComboboxData } from '@mantine/core';
import {
  Code,
  Group,
  HoverCard,
  Select,
  Stack,
  Text,
  useComputedColorScheme,
  useMantineTheme,
} from '@mantine/core';
import { getHotkeyHandler, useDebouncedValue, useHotkeys } from '@mantine/hooks';
import { IconChevronDown, IconSearch } from '@tabler/icons-react';
import type { Hit } from 'instantsearch.js';
import { useRouter } from 'next/router';
import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  Fragment,
} from 'react';
import type { InstantSearchProps, SearchBoxProps } from 'react-instantsearch';
import { Configure, InstantSearch, useInstantSearch, useSearchBox } from 'react-instantsearch';
import { ClearableAutoComplete } from '~/components/ClearableAutoComplete/ClearableAutoComplete';
import { slugit } from '~/utils/string-helpers';
import { instantMeiliSearch } from '@meilisearch/instant-meilisearch';
import { env } from '~/env/client';
import { ModelSearchItem } from '~/components/AutocompleteSearch/renderItems/models';
import { ArticlesSearchItem } from '~/components/AutocompleteSearch/renderItems/articles';
import { UserSearchItem } from '~/components/AutocompleteSearch/renderItems/users';
import { ImagesSearchItem } from '~/components/AutocompleteSearch/renderItems/images';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useIsMobile } from '~/hooks/useIsMobile';
import { CollectionsSearchItem } from '~/components/AutocompleteSearch/renderItems/collections';
import { BountiesSearchItem } from '~/components/AutocompleteSearch/renderItems/bounties';
import { useTrackEvent } from '../TrackView/track.utils';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import type { SearchIndexDataMap } from '~/components/Search/search.utils2';
import { useHitsTransformed } from '~/components/Search/search.utils2';
import type { ReverseSearchIndexKey, SearchIndexKey } from '~/components/Search/search.types';
import { reverseSearchIndexMap, searchIndexMap } from '~/components/Search/search.types';
import { isDefined, paired } from '~/utils/type-guards';
import { ApplyCustomFilter, BrowsingLevelFilter } from '../Search/CustomSearchComponents';
import { QS } from '~/utils/qs';
import { ToolSearchItem } from '~/components/AutocompleteSearch/renderItems/tools';
import { Availability } from '~/shared/utils/prisma/enums';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useBrowsingSettingsAddons } from '~/providers/BrowsingSettingsAddonsProvider';
import { getBlockedNsfwWords } from '~/utils/metadata/audit-base';
import { includesInappropriate, includesPoi } from '~/utils/metadata/audit';
import classes from './AutocompleteSearch.module.scss';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { truncate } from 'lodash-es';
import { usePathname } from 'next/navigation';
import { useDomainColor } from '~/hooks/useDomainColor';
import { useCheckProfanity } from '~/hooks/useCheckProfanity';

const meilisearch = instantMeiliSearch(
  env.NEXT_PUBLIC_SEARCH_HOST as string,
  env.NEXT_PUBLIC_SEARCH_CLIENT_KEY,
  { primaryKey: 'id' }
);

type Props = Omit<AutocompleteProps, 'data' | 'onSubmit'> & {
  onClear?: VoidFunction;
  onSubmit?: VoidFunction;
  searchBoxProps?: SearchBoxProps;
};

const searchClient: InstantSearchProps['searchClient'] = {
  ...meilisearch,
  search(requests) {
    // Prevent making a request if there is no query
    // @see https://www.algolia.com/doc/guides/building-search-ui/going-further/conditional-requests/react/#detecting-empty-search-requests
    // @see https://github.com/algolia/react-instantsearch/issues/1111#issuecomment-496132977
    if (requests.every(({ params }) => !params?.query)) {
      return Promise.resolve({
        results: requests.map(() => ({
          hits: [],
          nbHits: 0,
          nbPages: 0,
          page: 0,
          processingTimeMS: 0,
          hitsPerPage: 0,
          exhaustiveNbHits: false,
          query: '',
          params: '',
        })),
      });
    }

    return meilisearch.search(requests);
  },
};

const DEFAULT_DROPDOWN_ITEM_LIMIT = 6;

const targetData = [
  { value: 'models', label: 'Models' },
  { value: 'images', label: 'Images' },
  { value: 'articles', label: 'Articles' },
  { value: 'users', label: 'Users' },
  { value: 'collections', label: 'Collections' },
  { value: 'bounties', label: 'Bounties' },
  { value: 'tools', label: 'Tools' },
] as const;

export const AutocompleteSearch = forwardRef<{ focus: () => void }, Props>(({ ...props }, ref) => {
  const browsingSettingsAddons = useBrowsingSettingsAddons();
  const [targetIndex, setTargetIndex] = useState<SearchIndexKey>('models');
  const handleTargetChange = (value: SearchIndexKey) => {
    setTargetIndex(value);
  };
  const currentUser = useCurrentUser();

  const indexSupportsNsfwLevel = useMemo(
    () =>
      [
        searchIndexMap.articles,
        searchIndexMap.bounties,
        searchIndexMap.models,
        searchIndexMap.images,
        searchIndexMap.collections,
        searchIndexMap.tools,
      ].some((i) => i === searchIndexMap[targetIndex]),
    [targetIndex]
  );

  const isModels = targetIndex === 'models';
  const isImages = targetIndex === 'images';
  const supportsPoi = ['models', 'images'].includes(targetIndex);
  const supportsMinor = ['models', 'images'].includes(targetIndex);
  const filters = [
    isModels && supportsPoi && browsingSettingsAddons.settings.disablePoi
      ? `poi != true${currentUser?.id ? ` OR user.id = ${currentUser?.id}` : ''}`
      : null,
    isImages && supportsPoi && browsingSettingsAddons.settings.disablePoi
      ? `poi != true${currentUser?.username ? ` OR user.username = ${currentUser?.username}` : ''}`
      : null,
    supportsMinor && browsingSettingsAddons.settings.disableMinor ? 'minor != true' : null,
    isModels && !currentUser?.isModerator
      ? `availability != ${Availability.Private}${
          currentUser?.id ? ` OR user.id = ${currentUser?.id}` : ''
        }`
      : null,
  ].filter(isDefined);

  return (
    <InstantSearch
      searchClient={searchClient}
      indexName={searchIndexMap[targetIndex as keyof typeof searchIndexMap]}
      future={{ preserveSharedStateOnUnmount: false }}
    >
      {indexSupportsNsfwLevel ? (
        <BrowsingLevelFilter
          attributeName={indexSupportsNsfwLevel ? 'nsfwLevel' : ''}
          filters={filters}
        />
      ) : filters.length > 0 ? (
        <ApplyCustomFilter filters={filters} />
      ) : null}
      <AutocompleteSearchContent
        {...props}
        indexName={targetIndex}
        ref={ref}
        onTargetChange={handleTargetChange}
      />
    </InstantSearch>
  );
});

AutocompleteSearch.displayName = 'AutocompleteSearch';

type AutocompleteSearchProps<T extends SearchIndexKey> = Props & {
  indexName: T;
  onTargetChange: (target: T) => void;
};

function AutocompleteSearchContentInner<TKey extends SearchIndexKey>(
  {
    onClear,
    onSubmit,
    className,
    searchBoxProps,
    indexName: indexNameProp,
    onTargetChange,
    ...autocompleteProps
  }: AutocompleteSearchProps<TKey>,
  ref: React.ForwardedRef<{ focus: () => void }>
) {
  // const currentUser = useCurrentUser();
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  const browsingSettingsAddons = useBrowsingSettingsAddons();
  const router = useRouter();
  const isMobile = useIsMobile();
  const features = useFeatureFlags();
  const inputRef = useRef<HTMLInputElement>(null);
  const pathname = usePathname();
  const currentSection = pathname.split('/')[1] || 'models';
  const searchTarget = targetData.find((t) => t.value === currentSection)?.value ?? 'models';
  const domainColor = useDomainColor();

  const { status } = useInstantSearch({
    catchError: true,
  });

  const { query, refine: setQuery } = useSearchBox(searchBoxProps);
  const { hits, results } = useHitsTransformed<TKey>();
  const indexName = results?.index
    ? reverseSearchIndexMap[results.index as ReverseSearchIndexKey]
    : indexNameProp;

  const [selectedItem, setSelectedItem] = useState<ComboboxData[number] | null>(null);
  const [search, setSearch] = useState(query);
  const [filters, setFilters] = useState('');
  const [searchPageQuery, setSearchPageQuery] = useState('');
  const [debouncedSearch] = useDebouncedValue(search, 300);

  const { trackSearch, trackAction } = useTrackEvent();
  const searchErrorState = status === 'error';

  const { key, value } = paired<SearchIndexDataMap>(indexName, hits as SearchIndexDataMap[TKey]);
  const { items: filtered } = useApplyHiddenPreferences({
    type: key,
    data: value,
  });

  // Check for illegal search first
  const isIllegalSearch = useMemo(() => {
    if (!debouncedSearch) return false;
    const illegalSearch = includesInappropriate({ prompt: debouncedSearch });
    return illegalSearch === 'minor';
  }, [debouncedSearch]);

  // Check profanity in search query (only if not illegal and domain is green)
  const profanityAnalysis = useCheckProfanity(debouncedSearch, {
    enabled: domainColor === 'green' && !isIllegalSearch && !!debouncedSearch,
  });

  const isProfaneSearch = profanityAnalysis.hasProfanity;

  const items = useMemo(() => {
    const isIllegalQuery = debouncedSearch
      ? includesInappropriate({ prompt: debouncedSearch }) === 'minor'
      : false;
    const canPerformQuery = debouncedSearch
      ? !browsingSettingsAddons.settings.disablePoi || !includesPoi(debouncedSearch)
      : true;
    const hasBlockedWords = !!getBlockedNsfwWords(debouncedSearch).length;

    if (isIllegalQuery) {
      return [
        {
          key: 'blocked',
          value: debouncedSearch,
          hit: null as any,
          label: 'Blocked',
        },
      ];
    }

    // Check for profanity (only in green domain)
    if (isProfaneSearch && domainColor === 'green') {
      return [
        {
          key: 'profanity',
          value: debouncedSearch,
          hit: null as any,
          label: 'Blocked',
        },
      ];
    }

    if (!canPerformQuery) {
      return [
        {
          key: 'disabled',
          value: debouncedSearch,
          hit: null as any,
          label: 'Blocked',
        },
      ];
    }
    if (hasBlockedWords) {
      return [
        {
          key: 'blocked-words',
          value: debouncedSearch,
          hit: null as any,
          label: 'Blocked',
        },
      ];
    }

    if (searchErrorState) {
      return [
        {
          key: 'error',
          value: debouncedSearch,
          hit: null as any,
          label: 'Error',
        },
      ];
    }

    if (status === 'stalled') {
      return []; // Wait it out
    }

    const items = filtered.map((hit) => ({
      key: String(hit.id),
      hit,
      value: String(hit.id),
      label:
        'prompt' in hit
          ? truncate(hit.prompt, { length: 50 })
          : 'name' in hit
          ? hit.name
          : 'title' in hit
          ? hit.title
          : 'username' in hit
          ? hit.username
          : '',
    }));

    if (!!results?.nbHits && results.nbHits > DEFAULT_DROPDOWN_ITEM_LIMIT)
      items.push({ key: 'view-more', value: query, hit: null as any, label: 'View more results' });

    return items;
  }, [status, filtered, results?.nbHits, query]);

  // Track profanity search separately to avoid side effects in useMemo
  useEffect(() => {
    if (!debouncedSearch || !profanityAnalysis.hasProfanity || domainColor !== 'green') return;

    trackAction({
      type: 'ProfanitySearch',
      details: {
        query: debouncedSearch,
        index: searchIndexMap[indexName],
        matches: profanityAnalysis.matches,
      },
    }).catch(() => undefined);
  }, [
    debouncedSearch,
    domainColor,
    profanityAnalysis.hasProfanity,
    profanityAnalysis.matches,
    indexName,
  ]);

  const focusInput = () => inputRef.current?.focus();
  const blurInput = () => inputRef.current?.blur();

  useImperativeHandle(ref, () => ({
    focus: focusInput,
  }));

  const handleSubmit = () => {
    if (search) {
      const { query: cleanedSearch, searchPageQuery: currSearchPageQuery } = parseQuery(
        indexName,
        search
      );
      const queryString = QS.stringify({
        query: cleanedSearch.trim(), // Search should be more accurate than query as it was the latest written.
        ...QS.parse(currSearchPageQuery),
      });

      router.push(`/search/${indexName}?${queryString}`, undefined, { shallow: false });

      blurInput();
    }

    onSubmit?.();
  };

  const handleClear = () => {
    setSearch('');
    onClear?.();
  };

  const getItemFromValue = (value: string) => {
    return (
      items.find((i) => i.value === value) ?? {
        key: 'view-more',
        hit: null,
        value,
      }
    );
  };

  const handleItemClick = (value: string) => {
    const item = getItemFromValue(value);

    if (
      item.key === 'blocked' ||
      item.key === 'profanity' ||
      item.key === 'disabled' ||
      item.key === 'blocked-words' ||
      item.key === 'error'
    ) {
      // Do not allow to click on blocked items
      return;
    }

    if (item.hit) {
      // when an item is clicked
      router.push(processHitUrl(item.hit));
      trackSearch({ query: search, index: searchIndexMap[indexName] }).catch(() => null);
    } else {
      // when view more is clicked
      router.push(`/search/${indexName}?query=${encodeURIComponent(item.value)}`, undefined, {
        shallow: false,
      });
    }

    setSelectedItem({ label: item.key, value });
    onSubmit?.();
  };

  useHotkeys([
    ['/', focusInput],
    ['mod+k', focusInput],
  ]);

  useEffect(() => {
    // Only set the query when the debounced search changes
    // and user didn't select from the list
    if (debouncedSearch === query || selectedItem || searchErrorState) return;

    // Check if the query is an AIR
    const air = checkAIR(indexName, debouncedSearch);
    if (air) {
      // If it is, redirect to the appropriate page
      router.push(air);
      return;
    }

    const {
      query: cleanedSearch,
      filters,
      searchPageQuery,
    } = parseQuery(indexName, debouncedSearch);

    setQuery(cleanedSearch);
    setFilters(filters);
    setSearchPageQuery(searchPageQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, query]);

  // Clear selected item after search changes
  useEffect(() => {
    setSelectedItem(null);
  }, [debouncedSearch]);

  // Change index target when search target changes
  useEffect(() => {
    if (indexNameProp !== searchTarget) {
      onTargetChange(searchTarget as TKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTarget]);

  const processHitUrl = (hit: Hit) => {
    switch (indexName) {
      case 'articles':
        return `/${indexName}/${hit.id as number}/${slugit(hit.title)}`;
      case 'images':
      case 'collections':
        return `/${indexName}/${hit.id as number}`;
      case 'users':
        return `/user/${hit.username as string}`;
      case 'tools':
        return `/${indexName}/${slugit(hit.name)}`;
      case 'models':
      default:
        return `/${indexName}/${hit.id as number}/${slugit(hit.name)}`;
    }
  };

  return (
    <>
      <Configure hitsPerPage={DEFAULT_DROPDOWN_ITEM_LIMIT} filters={filters} />
      <Group className={classes.wrapper} gap={0} wrap="nowrap">
        <Select
          key={pathname}
          classNames={{
            root: classes.targetSelectorRoot,
            input: classes.targetSelectorInput,
            option: classes.targetSelectorOption,
            options: classes.targetSelectorOptions,
            dropdown: classes.targetSelectorDropdown,
          }}
          rightSectionProps={{
            className: classes.targetSelectorRightSection,
          }}
          maxDropdownHeight={280}
          defaultValue={searchTarget}
          // Ensure we disable search targets if they are not enabled
          data={targetData.filter(
            ({ value }) =>
              (features.imageSearch ? true : value !== 'images') &&
              (features.bounties ? true : value !== 'bounties') &&
              (features.articles ? true : value !== 'articles') &&
              (features.toolSearch ? true : value !== 'tools')
          )}
          rightSection={<IconChevronDown size={16} color="currentColor" />}
          style={{ flexShrink: 1 }}
          onChange={(v: string | null) => onTargetChange(v as TKey)}
          autoComplete="off"
          allowDeselect={false}
        />
        <ClearableAutoComplete
          ref={inputRef}
          key={indexName}
          className={className}
          classNames={classes}
          placeholder="Search Civitai"
          type="search"
          limit={
            results && results.nbHits > DEFAULT_DROPDOWN_ITEM_LIMIT
              ? DEFAULT_DROPDOWN_ITEM_LIMIT + 1 // Allow one more to show more results option
              : DEFAULT_DROPDOWN_ITEM_LIMIT
          }
          defaultValue={query}
          value={search}
          data={items}
          onChange={(value) => {
            if (!value || value === 'View more results') return;
            setSearch(value);
          }}
          onBlur={handleClear}
          onClear={handleClear}
          onKeyDown={getHotkeyHandler([
            ['Escape', blurInput],
            ['Enter', handleSubmit],
          ])}
          onOptionSubmit={handleItemClick}
          renderOption={({ option }) => {
            const { key, ...item } = getItemFromValue(option.value);
            // Render special states
            if (key === 'blocked') {
              return (
                <Stack gap="xs" align="center">
                  <Text size="sm" align="center">
                    Your search query contains inappropriate content and has been blocked.
                  </Text>
                  <Text size="xs" align="center">
                    Please try a different search term.
                  </Text>
                </Stack>
              );
            }
            if (key === 'profanity') {
              return (
                <Stack gap="xs" align="center">
                  <Text size="sm" align="center">
                    Your search query contains inappropriate content that violates our community
                    guidelines.
                  </Text>
                  {profanityAnalysis.matches.length > 0 && (
                    <Text size="xs" align="center" c="dimmed">
                      Flagged terms: {profanityAnalysis.matches.join(', ')}
                    </Text>
                  )}
                  <Text size="xs" align="center">
                    Please refine your search terms to find appropriate content.
                  </Text>
                </Stack>
              );
            }
            if (key === 'disabled') {
              return (
                <Stack gap="xs" align="center">
                  <Text size="sm" align="center">
                    Due to your current browsing settings, searching for people of interest has been
                    disabled.
                  </Text>
                  <Text size="xs" align="center">
                    You may remove X and XXX browsing settings to search for these.
                  </Text>
                </Stack>
              );
            }
            if (key === 'blocked-words') {
              return (
                <Stack gap="xs" align="center">
                  <Text size="sm" align="center">
                    Your search query contains blocked words and has been filtered.
                  </Text>
                  <Text size="xs" align="center">
                    Please try a different search term.
                  </Text>
                </Stack>
              );
            }
            if (key === 'error') {
              return (
                <Stack gap="xs" align="center">
                  <Text size="sm" align="center">
                    There was an error while performing your request&hellip;
                  </Text>
                  <Text size="xs" align="center">
                    Please try again later
                  </Text>
                </Stack>
              );
            }

            const Render = IndexRenderItem[indexName] ?? ModelSearchItem;
            return <Render {...item} />;
          }}
          rightSection={
            <HoverCard withArrow width={300} shadow="sm" openDelay={500}>
              <HoverCard.Target>
                <Text
                  fw="bold"
                  style={{
                    border: `1px solid ${
                      colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3]
                    }`,
                    borderRadius: theme.radius.sm,
                    backgroundColor:
                      colorScheme === 'dark' ? theme.colors.dark[7] : theme.colors.gray[0],
                    color: colorScheme === 'dark' ? theme.colors.gray[5] : theme.colors.gray[6],
                    textAlign: 'center',
                    width: 24,
                    userSelect: 'none',
                  }}
                >
                  /
                </Text>
              </HoverCard.Target>
              <HoverCard.Dropdown>
                <Text size="sm" c="yellow" fw={500}>
                  Pro-tip: Quick search faster!
                </Text>
                <Text size="xs" lh={1.2}>
                  Open the quick search without leaving your keyboard by tapping the <Code>/</Code>{' '}
                  key from anywhere and just start typing.
                </Text>
              </HoverCard.Dropdown>
            </HoverCard>
          }
          // prevent default filtering behavior
          filter={({ options }) => options}
          clearable={query.length > 0}
          maxDropdownHeight={isMobile ? 'calc(90vh - var(--header-height))' : 500}
          {...autocompleteProps}
        />
        <LegacyActionIcon
          className={classes.searchButton}
          color="gray"
          variant="filled"
          size={36}
          onMouseDown={handleSubmit}
        >
          <IconSearch size={18} />
        </LegacyActionIcon>
      </Group>
    </>
  );
}

const AutocompleteSearchContent = React.forwardRef(AutocompleteSearchContentInner);

const IndexRenderItem: Record<SearchIndexKey, React.ComponentType<any>> = {
  models: ModelSearchItem,
  articles: ArticlesSearchItem,
  users: UserSearchItem,
  images: ImagesSearchItem,
  collections: CollectionsSearchItem,
  bounties: BountiesSearchItem,
  tools: ToolSearchItem,
};

const queryFilters: Record<
  string,
  { AIR?: RegExp; filters: Record<string, RegExp>; searchPageMap: Record<string, string> }
> = {
  models: {
    AIR: /^civitai:(?<modelId>\d+)@(?<modelVersionId>\d+)/g,
    filters: {
      'tags.name': /(^|\s+)(?<not>!|-)?#(?<value>\w+)/g,
      'user.username': /(^|\s+)(?<not>!|-)?@(?<value>\w+)/g,
      'versions.hashes': /(^|\s+)(?<not>!|-)?hash:(?<value>[A-Za-z0-9_.-]+)/g,
    },
    searchPageMap: {
      'user.username': 'users',
      'tags.name': 'tags',
    },
  },
};

function checkAIR(index: string, query: string) {
  const filterAttributes = queryFilters[index] ?? {};

  if (!filterAttributes?.AIR) {
    return null;
  }

  const { AIR } = filterAttributes;
  const [match] = query.matchAll(AIR);

  if (!match) return null;

  if (index === 'models') {
    const modelId = match?.groups?.modelId;
    const modelVersionId = match?.groups?.modelVersionId;

    if (!modelId || !modelVersionId) return null;

    return `/models/${modelId}?modelVersionId=${modelVersionId}`;
  }

  return null;
}

function parseQuery(index: string, query: string) {
  const filterAttributes = queryFilters[index];
  const filters = [];
  const searchPageQuery = [];

  if (filterAttributes) {
    for (const [attribute, regex] of Object.entries(filterAttributes.filters)) {
      for (const match of query.matchAll(regex)) {
        const cleanedMatch = match?.groups?.value?.trim();
        const not = match?.groups?.not !== undefined;
        if (!cleanedMatch) continue;
        filters.push(`${not ? 'NOT ' : ''}${attribute} = ${cleanedMatch}`);
        searchPageQuery.push(
          `${filterAttributes.searchPageMap[attribute] ?? attribute}=${encodeURIComponent(
            cleanedMatch ?? ''
          )}`
        );
      }

      query = query.replace(regex, '');
      if (query.length === 0 && filters.length !== 0) query = ' ';
    }
  }

  return { query, filters: filters.join(' AND '), searchPageQuery: searchPageQuery.join('&') };
}
