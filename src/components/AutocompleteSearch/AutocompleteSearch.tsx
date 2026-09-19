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
import { InstantSearch, useInstantSearch, useSearchBox } from 'react-instantsearch';
import { ClearableAutoComplete } from '~/components/ClearableAutoComplete/ClearableAutoComplete';
import { slugit } from '~/utils/string-helpers';
import { instantMeiliSearch } from '@meilisearch/instant-meilisearch';
import { withUserHydration } from '~/components/Search/userHydration';
import { env } from '~/env/client';
import { createResilientSearchClient } from '~/components/Search/resilientSearchClient';
import {
  shouldRefineSearchQuery,
  useCarriedSearchText,
} from '~/components/Search/useCarriedSearchText';
import { quoteMeiliValue } from '~/components/Search/meili-filter';
import {
  autocompleteAvailability,
  useAutocompleteAvailabilityStore,
} from '~/components/Search/search-availability.store';
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
import { BrowsingLevelFilter } from '../Search/CustomSearchComponents';
import {
  buildSearchPageUrl,
  checkAIR,
  parseQuery,
} from '~/components/AutocompleteSearch/autocomplete-query';
import { ToolSearchItem } from '~/components/AutocompleteSearch/renderItems/tools';
import { ComicsSearchItem } from '~/components/AutocompleteSearch/renderItems/comics';
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
import { useBenignPhrases } from '~/hooks/useBenignPhrases';

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

// Wrapped so a Meili outage degrades to empty results instead of an uncaught
// `MeiliSearchCommunicationError`. On fallback it flips the autocomplete
// availability flag so the dropdown shows its "Error" item (the swallowed error
// never reaches `useInstantSearch().status`, so we can't key off that).
const searchClient: InstantSearchProps['searchClient'] = withUserHydration(
  createResilientSearchClient(
    {
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
    },
    {
      onError: () => autocompleteAvailability.setUnavailable(true),
      onSuccess: () => autocompleteAvailability.setUnavailable(false),
    }
  )
);

const DEFAULT_DROPDOWN_ITEM_LIMIT = 6;

const targetData = [
  { value: 'models', label: 'Models' },
  { value: 'images', label: 'Images' },
  { value: 'articles', label: 'Articles' },
  { value: 'users', label: 'Users' },
  { value: 'collections', label: 'Collections' },
  { value: 'bounties', label: 'Bounties' },
  { value: 'tools', label: 'Tools' },
  { value: 'comics', label: 'Comics' },
] as const;

export const AutocompleteSearch = forwardRef<{ focus: () => void }, Props>(({ ...props }, ref) => {
  const browsingSettingsAddons = useBrowsingSettingsAddons();
  const features = useFeatureFlags();
  const [targetIndex, setTargetIndex] = useState<SearchIndexKey>('models');
  const handleTargetChange = (value: SearchIndexKey) => {
    setTargetIndex(value);
  };
  const currentUser = useCurrentUser();
  // Owned above the keyed search provider below, so it outlives the remount an index switch
  // causes.
  const carriedSearchText = useRef('');

  // Follow the section the user navigates to. This has to live ABOVE the keyed provider for the
  // same reason the carrier does: inside it, the effect would run again on the mount that a
  // target switch causes, read a section the user has not navigated to, and immediately revert
  // their pick — so the category selector would only ever "work" when it picked what the URL
  // already said.
  const pathname = usePathname();
  const currentSection = pathname.split('/')[1] || 'models';
  const searchTarget = targetData.find((t) => t.value === currentSection)?.value ?? 'models';
  useEffect(() => {
    // A navigation is not the switch the carry exists for. The input's blur handler empties the
    // visible text WITHOUT emptying the carrier (a blur is how you reach the category selector at
    // all), so text a user typed and walked away from would otherwise reappear — and be searched
    // again — in the next section they land in.
    //
    // 🔴 This runs when `searchTarget` CHANGES, which is narrower than "on navigation": the line
    // above collapses every first path segment outside `targetData` to `'models'`, so `/` →
    // `/models/123/slug`, or any move between two such paths, leaves it unchanged and this never
    // runs. The other explicit discard is `blurAndDiscardCarriedText`, on submit and on Escape;
    // separately, emptying the input discards through the setter. Together they narrow the window
    // rather than closing it, and the remainder is deliberate: text blurred away and then left
    // alone survives in the carrier until the next pick from the selector re-seeds it.
    carriedSearchText.current = '';
    setTargetIndex(searchTarget);
  }, [searchTarget]);

  const isModels = targetIndex === 'models';
  const isImages = targetIndex === 'images';
  const supportsPoi = ['models', 'images'].includes(targetIndex);
  const supportsMinor = ['models', 'images'].includes(targetIndex);
  const filters = [
    isModels && supportsPoi && browsingSettingsAddons.settings.disablePoi
      ? `poi != true${currentUser?.id ? ` OR user.id = ${currentUser?.id}` : ''}`
      : null,
    isImages && supportsPoi && browsingSettingsAddons.settings.disablePoi
      ? `poi != true${
          currentUser?.username
            ? ` OR user.username = ${quoteMeiliValue(currentUser.username)}`
            : ''
        }`
      : null,
    supportsMinor && browsingSettingsAddons.settings.disableMinor ? 'minor != true' : null,
    isModels && !currentUser?.isModerator
      ? `availability != ${Availability.Private}${
          currentUser?.id ? ` OR user.id = ${currentUser?.id}` : ''
        }`
      : null,
  ].filter(isDefined);

  const resolvedIndexName = searchIndexMap[targetIndex as keyof typeof searchIndexMap];

  // The options the selector OFFERS: every target, narrowed by feature flag. Computed once here
  // because the render below reads it twice — as `data`, and in the `value` expression that
  // blanks the label when the target is not one of these.
  const enabledTargets = targetData.filter(
    ({ value }) =>
      (features.imageSearch ? true : value !== 'images') &&
      (features.bounties ? true : value !== 'bounties') &&
      (features.articles ? true : value !== 'articles') &&
      (features.toolSearch ? true : value !== 'tools') &&
      (features.comicSearch ? true : value !== 'comics')
  );

  return (
    <Group className={classes.wrapper} gap={0} wrap="nowrap">
      {/*
        ABOVE the keyed provider, and that placement is the point. `<InstantSearch>` returns `null`
        whenever its search instance is not STARTED, and outside server rendering it is started
        from a subscription callback that runs after a render has committed — so every fresh
        provider renders once with no subtree at all, and a key change builds a fresh provider.
        Inside it, the control the user just clicked would be destroyed and rebuilt by their own
        click — focus lands on `<body>`. It consumes nothing from the provider's context, so
        nothing is lost by lifting it out.
      */}
      <Select
        // CONTROLLED. Uncontrolled, its displayed label is internal state, so a target switch
        // driven from anywhere else — the URL-follow effect above — would leave it showing a
        // category the search has moved off: a selector that lies about what it is searching.
        //
        // `null` rather than the target when the target is not an OFFERED option: the URL can
        // point the search at an index whose feature flag is off, and Mantine leaves a
        // controlled value it cannot resolve showing the PREVIOUS option's label. Blank is
        // honest about "none of these"; a stale label is the same lie in a different place.
        value={enabledTargets.some(({ value }) => value === targetIndex) ? targetIndex : null}
        aria-label="Search category"
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
        data={enabledTargets}
        rightSection={<IconChevronDown size={16} color="currentColor" />}
        style={{ flexShrink: 1 }}
        onChange={(v: string | null) => handleTargetChange(v as SearchIndexKey)}
        autoComplete="off"
        allowDeselect={false}
      />
      <InstantSearch
        // Needs re-render, the same way `SearchLayout` does it. Otherwise the search fires with the
        // previous index's parameters: react-instantsearch sets the new index and searches in its
        // render body, before the children that own `filters` have re-rendered.
        key={resolvedIndexName}
        searchClient={searchClient}
        indexName={resolvedIndexName}
        future={{ preserveSharedStateOnUnmount: false }}
      >
        <AutocompleteSearchContent
          {...props}
          indexName={targetIndex}
          ref={ref}
          baseFilters={filters}
          carriedSearchText={carriedSearchText}
        />
      </InstantSearch>
    </Group>
  );
});

AutocompleteSearch.displayName = 'AutocompleteSearch';

type AutocompleteSearchProps<T extends SearchIndexKey> = Props & {
  indexName: T;
  baseFilters: string[];
  carriedSearchText: React.MutableRefObject<string>;
};

function AutocompleteSearchContentInner<TKey extends SearchIndexKey>(
  {
    onClear,
    onSubmit,
    className,
    searchBoxProps,
    indexName: indexNameProp,
    baseFilters,
    carriedSearchText,
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
  const inputRef = useRef<HTMLInputElement>(null);
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
  const [search, setSearch, clearDisplayedText] = useCarriedSearchText(carriedSearchText, query);
  const [queryFilters, setQueryFilters] = useState('');
  const [debouncedSearch] = useDebouncedValue(search, 300);

  const { trackSearch, trackAction } = useTrackEvent();
  // The resilient search client swallows Meili comm errors (so they never reach
  // `useInstantSearch().status === 'error'`); it flips this flag on fallback
  // instead, which keeps the dropdown's "Error" item + the AIR-redirect gate
  // working during a Meili blip.
  const searchErrorState = useAutocompleteAvailabilityStore((state) => state.unavailable);

  const { key, value } = paired<SearchIndexDataMap>(indexName, hits as SearchIndexDataMap[TKey]);
  const { items: filtered } = useApplyHiddenPreferences({
    type: key,
    data: value,
  });

  // Check for illegal search first
  const benignPhrases = useBenignPhrases();
  // Detection reads the whitelisted copy; the query sent to Meili stays the raw text.
  const auditedSearch = useMemo(
    () => benignPhrases.strip(debouncedSearch),
    [benignPhrases, debouncedSearch]
  );

  const isIllegalSearch = useMemo(() => {
    if (!debouncedSearch) return false;
    const illegalSearch = includesInappropriate({ prompt: auditedSearch });
    return illegalSearch === 'minor';
  }, [debouncedSearch, auditedSearch]);

  // Check profanity in search query (only if not illegal and domain is green)
  const profanityAnalysis = useCheckProfanity(debouncedSearch, {
    enabled: domainColor === 'green' && !isIllegalSearch && !!debouncedSearch,
  });

  const isProfaneSearch = profanityAnalysis.hasProfanity;

  const items = useMemo(() => {
    const isIllegalQuery = debouncedSearch
      ? includesInappropriate({ prompt: auditedSearch }) === 'minor'
      : false;
    const canPerformQuery = debouncedSearch
      ? !browsingSettingsAddons.settings.disablePoi || !includesPoi(auditedSearch)
      : true;
    // Raw text on purpose: this reads a different list (blocked NSFW words) which the benign
    // phrases do not carve out, and it blocks rather than flags.
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
  }, [status, searchErrorState, filtered, results?.nbHits, query]);

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

  // Submitting a search and pressing Escape are the two ways a user says they are finished with
  // what they typed, so both discard the carried copy as well as blurring. One function rather
  // than the line written at each call site: the two must not drift apart.
  //
  // Deliberately NOT inside `blurInput`, which this is now the only caller of — so the two
  // placements are behaviourally identical at this head. `blurInput` is a DOM verb and the
  // discard is a claim about intent: put inside it, a future caller that is not a "done" signal
  // would inherit the discard silently. (Nothing else blurs at all today: the imperative handle
  // below exposes `focus` only.)
  //
  // 🔴 And NOT from `handleBlur`. Reaching the category selector requires blurring this input, so
  // a discard there would empty the carrier immediately before the one switch the carry exists
  // for — which is what made the carry inert on this component before.
  const blurAndDiscardCarriedText = () => {
    carriedSearchText.current = '';
    blurInput();
  };

  useImperativeHandle(ref, () => ({
    focus: focusInput,
  }));

  // Not the refined `query`: `parseQuery` has already stripped the `#tag`/`@user` tokens out of it.
  const searchPageUrl = () => buildSearchPageUrl(indexName, search);

  const handleSubmit = () => {
    if (search) {
      router.push(searchPageUrl(), undefined, { shallow: false });

      // Inside the `if`, where the blur already was: the carrier is discarded on the branch that
      // acted on the text. Enter over an EMPTY input — which is what the box reads as after a
      // blur, since nothing re-seeds it on focus — discards nothing, and that is the same
      // residue the effect above describes.
      blurAndDiscardCarriedText();
    }

    onSubmit?.();
  };

  // The explicit clear — the input's clear button. The user asked for the text to go, so the
  // carrier goes with it.
  const handleClear = () => {
    setSearch('');
    onClear?.();
  };

  // Blur empties the input the same way it always has, but leaves the carried copy alone. Reaching
  // the category selector REQUIRES blurring this input, so a blur that wrote through `setSearch`
  // emptied the carrier immediately before every selector-driven index switch — the one path the
  // carry exists for. `onClear?.()` still fires, unchanged: on mobile it is what closes the search
  // overlay (`AppHeader` passes `onSearchDone`), and that is not ours to change here.
  const handleBlur = () => {
    clearDisplayedText();
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
      router.push(searchPageUrl(), undefined, { shallow: false });
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
    if (!shouldRefineSearchQuery(debouncedSearch, query, !!selectedItem || searchErrorState))
      return;

    // Check if the query is an AIR
    const air = checkAIR(indexName, debouncedSearch);
    if (air) {
      // If it is, redirect to the appropriate page
      router.push(air);
      return;
    }

    const { query: cleanedSearch, filters } = parseQuery(indexName, debouncedSearch);

    setQuery(cleanedSearch);
    setQueryFilters(filters);
    // `searchErrorState` is a module-level store, so it is the one input here that SURVIVES the
    // remount an index switch causes. Without it in the deps, a tree that remounted while search
    // was unavailable restores the typed text, returns early, and then never refines when the
    // flag clears — the box reads as populated while the fresh helper's query is still empty.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, query, indexName, searchErrorState]);

  // Clear selected item after search changes
  useEffect(() => {
    setSelectedItem(null);
  }, [debouncedSearch]);

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
      case 'comics':
        return `/comics/${hit.id as number}`;
      case 'models':
      default:
        return `/${indexName}/${hit.id as number}/${slugit(hit.name)}`;
    }
  };

  return (
    <>
      <BrowsingLevelFilter
        indexKey={indexNameProp}
        filters={[...baseFilters, queryFilters]}
        hitsPerPage={DEFAULT_DROPDOWN_ITEM_LIMIT}
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
          if (value == null || value === 'View more results') return;
          setSearch(value);
        }}
        onBlur={handleBlur}
        onClear={handleClear}
        onKeyDown={getHotkeyHandler([
          ['Escape', blurAndDiscardCarriedText],
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
                  Your search includes terms tied to real people. Content depicting real people is
                  filtered from search results.
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
                component="div"
                role="button"
                tabIndex={0}
                aria-label="Quick search keyboard shortcut"
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
        aria-label="Search"
      >
        <IconSearch size={18} />
      </LegacyActionIcon>
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
  comics: ComicsSearchItem,
};
