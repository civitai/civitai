import {
  Anchor,
  AutocompleteItem,
  AutocompleteProps,
  Badge,
  Center,
  Code,
  Group,
  HoverCard,
  Rating,
  Stack,
  Text,
  ThemeIcon,
  createStyles,
} from '@mantine/core';
import { getHotkeyHandler, useDebouncedValue, useHotkeys } from '@mantine/hooks';
import {
  IconBrush,
  IconDownload,
  IconHeart,
  IconMessageCircle2,
  IconPhotoOff,
  IconSearch,
} from '@tabler/icons-react';
import type { Hit } from 'instantsearch.js';
import { useRouter } from 'next/router';
import React, { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import { Configure, Highlight, SearchBoxProps, useHits, useSearchBox } from 'react-instantsearch';
import { ClearableAutoComplete } from '~/components/ClearableAutoComplete/ClearableAutoComplete';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { ModelSearchIndexRecord } from '~/server/search-index/models.search-index';
import { abbreviateNumber } from '~/utils/number-helpers';
import { slugit } from '~/utils/string-helpers';
// import { AutocompleteDropdown } from './AutocompleteDropdown';

type Props = Omit<AutocompleteProps, 'data'> & {
  onClear?: VoidFunction;
  onSubmit?: VoidFunction;
  searchBoxProps?: SearchBoxProps;
};

const DEFAULT_DROPDOWN_ITEM_LIMIT = 6;
const useStyles = createStyles((theme) => ({
  root: {
    [theme.fn.smallerThan('md')]: {
      height: '100%',
    },
  },
  wrapper: {
    [theme.fn.smallerThan('md')]: {
      height: '100%',
    },
  },
  input: {
    [theme.fn.smallerThan('md')]: {
      height: '100%',
    },
  },
}));

export function AutocompleteSearch({
  onClear,
  onSubmit,
  className,
  searchBoxProps,
  ...autocompleteProps
}: Props) {
  const { classes } = useStyles();
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  const { query, refine: setQuery } = useSearchBox(searchBoxProps);
  const { hits, results } = useHits<ModelSearchIndexRecord>();

  const [selectedItem, setSelectedItem] = useState<AutocompleteItem | null>(null);
  const [search, setSearch] = useState(query);
  const [debouncedSearch] = useDebouncedValue(search, 300);

  // Prep items to display in dropdown
  const items = useMemo(() => {
    if (!results || !results.nbHits) return [];

    type Item = AutocompleteItem & { hit: Hit<ModelSearchIndexRecord> | null };
    const items: Item[] = hits.map((hit) => ({ value: hit.name, hit }));
    // If there are more results than the default limit,
    // then we add a "view more" option
    if (results.nbHits > DEFAULT_DROPDOWN_ITEM_LIMIT)
      items.push({ key: 'view-more', value: query, hit: null });

    return items;
  }, [hits, query, results]);

  const focusInput = () => inputRef.current?.focus();
  const blurInput = () => inputRef.current?.blur();

  const handleSubmit = () => {
    if (search) {
      router.push(`/search/models?query=${encodeURIComponent(search)}`);
      blurInput();
    }
    onSubmit?.();
  };

  const handleClear = () => {
    setSearch('');
    onClear?.();
  };

  useHotkeys([
    ['/', focusInput],
    ['mod+k', focusInput],
  ]);

  useEffect(() => {
    // Only set the query when the debounced search changes
    // and user didn't select from the list
    if (debouncedSearch !== query && !selectedItem) {
      setQuery(debouncedSearch);
      return;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, query]);

  // Clear selected item after search changes
  useEffect(() => {
    setSelectedItem(null);
  }, [debouncedSearch]);

  return (
    <>
      <Configure hitsPerPage={DEFAULT_DROPDOWN_ITEM_LIMIT} />
      <ClearableAutoComplete
        ref={inputRef}
        className={className}
        classNames={classes}
        placeholder="Search models, users, images, tags, etc."
        type="search"
        nothingFound={query && !hits.length ? 'No results found' : undefined}
        icon={<IconSearch />}
        limit={
          results && results.nbHits > DEFAULT_DROPDOWN_ITEM_LIMIT
            ? DEFAULT_DROPDOWN_ITEM_LIMIT + 1 // Allow one more to show more results option
            : DEFAULT_DROPDOWN_ITEM_LIMIT
        }
        defaultValue={query}
        value={search}
        data={items}
        onChange={setSearch}
        onClear={handleClear}
        onKeyDown={getHotkeyHandler([
          ['Escape', blurInput],
          ['Enter', handleSubmit],
        ])}
        onBlur={() => onClear?.()}
        onItemSubmit={(item) => {
          item.hit
            ? router.push(`/models/${item.hit.id}/${slugit(item.hit.name)}`) // when a model is clicked
            : router.push(`/search/models?query=${encodeURIComponent(item.value)}`); // when view more is clicked

          setSelectedItem(item);
          onSubmit?.();
        }}
        itemComponent={ModelSearchItem}
        // dropdownComponent={AutocompleteDropdown}
        rightSection={
          <HoverCard withArrow width={300} shadow="sm" openDelay={500}>
            <HoverCard.Target>
              <Text
                weight="bold"
                sx={(theme) => ({
                  border: `1px solid ${
                    theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3]
                  }`,
                  borderRadius: theme.radius.sm,
                  backgroundColor:
                    theme.colorScheme === 'dark' ? theme.colors.dark[7] : theme.colors.gray[0],
                  color: theme.colorScheme === 'dark' ? theme.colors.gray[5] : theme.colors.gray[6],
                  textAlign: 'center',
                  width: 24,
                  userSelect: 'none',
                })}
              >
                /
              </Text>
            </HoverCard.Target>
            <HoverCard.Dropdown>
              <Text size="sm" color="yellow" weight={500}>
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
        filter={() => true}
        clearable={query.length > 0}
        {...autocompleteProps}
      />
    </>
  );
}

type SearchItemProps = AutocompleteItem & { hit: Hit<ModelSearchIndexRecord> };

const useSearchItemStyles = createStyles((theme) => ({
  highlighted: {
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.yellow[5] : theme.colors.yellow[2],
  },
}));

const ViewMoreItem = forwardRef<HTMLDivElement, AutocompleteItem>(({ value, ...props }, ref) => {
  return (
    <Center ref={ref} {...props} key="view-more">
      <Anchor weight="bold" td="none !important">
        View more results
      </Anchor>
    </Center>
  );
});

ViewMoreItem.displayName = 'SearchItem';

const ModelSearchItem = forwardRef<HTMLDivElement, SearchItemProps>(
  ({ value, hit, ...props }, ref) => {
    const features = useFeatureFlags();
    const { classes, theme } = useSearchItemStyles();

    if (!hit) return <ViewMoreItem ref={ref} value={value} {...props} />;

    const { images, user, nsfw, type, category, metrics, modelVersion } = hit;
    let coverImage = images[0];
    for (const image of images) {
      if (coverImage.nsfw === 'None') break;
      if (image.nsfw === 'None') {
        coverImage = image;
        break;
      }
    }

    return (
      <Group ref={ref} {...props} key={hit.id} spacing="md" align="flex-start" noWrap>
        <Center
          sx={{
            width: 64,
            height: 64,
            position: 'relative',
            overflow: 'hidden',
            borderRadius: theme.radius.sm,
          }}
        >
          {coverImage ? (
            nsfw || coverImage.nsfw !== 'None' ? (
              <MediaHash {...coverImage} cropFocus="top" />
            ) : (
              <EdgeMedia
                src={coverImage.url}
                name={coverImage.name ?? coverImage.id.toString()}
                type={coverImage.type}
                anim={false}
                width={450}
                style={{
                  minWidth: '100%',
                  minHeight: '100%',
                  objectFit: 'cover',
                  position: 'absolute',
                  top: 0,
                  left: 0,
                }}
              />
            )
          ) : (
            <ThemeIcon variant="light" size={64} radius={0}>
              <IconPhotoOff size={32} />
            </ThemeIcon>
          )}
        </Center>
        <Stack spacing={4} sx={{ flex: '1 !important' }}>
          <Group spacing={8}>
            <Text>
              <Highlight attribute="name" hit={hit} classNames={classes} />
            </Text>
            {features.imageGeneration && !!modelVersion.generationCoverage?.covered && (
              <ThemeIcon color="white" variant="filled" radius="xl" size="sm">
                <IconBrush size={12} stroke={2.5} color={theme.colors.dark[6]} />
              </ThemeIcon>
            )}
          </Group>
          <Group spacing={8}>
            <UserAvatar size="xs" user={user} withUsername />
            {nsfw && (
              <Badge size="xs" color="red">
                NSFW
              </Badge>
            )}
            <Badge size="xs">{type}</Badge>
            {category && <Badge size="xs">{category.tag.name}</Badge>}
          </Group>
          <Group spacing={4}>
            <IconBadge
              // @ts-ignore: ignoring because size doesn't allow number
              icon={<Rating value={metrics.rating} size={12} readOnly />}
            >
              {abbreviateNumber(metrics.ratingCount)}
            </IconBadge>
            <IconBadge icon={<IconHeart size={12} stroke={2.5} />}>
              {abbreviateNumber(metrics.favoriteCount)}
            </IconBadge>
            <IconBadge icon={<IconMessageCircle2 size={12} stroke={2.5} />}>
              {abbreviateNumber(metrics.commentCount)}
            </IconBadge>
            <IconBadge icon={<IconDownload size={12} stroke={2.5} />}>
              {abbreviateNumber(metrics.downloadCount)}
            </IconBadge>
          </Group>
        </Stack>
      </Group>
    );
  }
);

ModelSearchItem.displayName = 'ModelSearchItem';
