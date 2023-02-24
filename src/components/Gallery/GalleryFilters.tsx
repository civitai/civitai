import {
  ActionIcon,
  Box,
  Button,
  Chip,
  ChipProps,
  createStyles,
  Divider,
  Group,
  Indicator,
  MultiSelect,
  Popover,
  ScrollArea,
  SegmentedControl,
  Stack,
} from '@mantine/core';
import { ImageGenerationProcess, MetricTimeframe } from '@prisma/client';
import {
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconFilter,
  IconFilterOff,
} from '@tabler/icons';
import { deleteCookie } from 'cookies-next';
import { useRouter } from 'next/router';
import { useRef, useState, useEffect } from 'react';
import z from 'zod';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

import { SelectMenu } from '~/components/SelectMenu/SelectMenu';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { galleryFilterSchema, useCookies } from '~/providers/CookiesProvider';
import { constants } from '~/server/common/constants';
import { BrowsingMode, ImageResource, ImageSort, TagSort } from '~/server/common/enums';
import { setCookie } from '~/utils/cookies-helpers';
import { splitUppercase } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

const numberType = z.preprocess((arg) => {
  return !!arg ? Number(arg) : undefined;
}, z.number().optional());

const queryStringSchema = z
  .object({
    modelId: numberType,
    modelVersionId: numberType,
    reviewId: numberType,
    userId: numberType,
    infinite: z.preprocess((arg) => {
      return arg === 'false' ? false : true;
    }, z.boolean()),
  })
  .optional();

type QueryFilterProps = z.infer<typeof queryStringSchema>;
type FilterProps = z.input<typeof galleryFilterSchema>;
type Store = {
  filters: FilterProps;
  setSort: (sort?: ImageSort) => void;
  setPeriod: (period?: MetricTimeframe) => void;
  setBrowsingMode: (browsingMode?: BrowsingMode, keep?: boolean) => void;
  setTypes: (types?: ImageGenerationProcess[]) => void;
  setResources: (resources?: ImageResource[]) => void;
  setTags: (tags?: number[]) => void;
  setExcludedTags: (tags?: number[]) => void;
  setSingleImageModel: (single?: boolean) => void;
  setSingleImageAlbum: (single?: boolean) => void;
};

const useFiltersStore = create<Store>()(
  immer((set) => ({
    filters: {},
    setSort: (sort) => {
      set((state) => {
        state.filters.sort = sort;
        !!sort ? setCookie('g_sort', sort) : deleteCookie('g_sort');
      });
    },
    setPeriod: (period) => {
      set((state) => {
        state.filters.period = period;
        !!period ? setCookie('g_period', period) : deleteCookie('g_period');
      });
    },
    setBrowsingMode: (mode, keep) => {
      set((state) => {
        state.filters.browsingMode = mode;
        mode && keep ? setCookie('g_browsingMode', mode) : deleteCookie('g_browsingMode');
      });
    },
    setTypes: (types) => {
      set((state) => {
        state.filters.types = types;
        !!types?.length ? setCookie('g_types', types) : deleteCookie('g_types');
      });
    },
    setTags: (tags) => {
      set((state) => {
        state.filters.tags = tags;
        !!tags?.length ? setCookie('g_tags', tags) : deleteCookie('g_tags');
      });
    },
    setExcludedTags: (excludedTags) => {
      set((state) => {
        state.filters.excludedTags = excludedTags;
        !!excludedTags?.length
          ? setCookie('g_excludedTags', excludedTags)
          : deleteCookie('g_excludedTags');
      });
    },
    setResources: (resources) => {
      set((state) => {
        state.filters.resources = resources;
        !!resources?.length ? setCookie('g_resources', resources) : deleteCookie('g_resources');
      });
    },
    setSingleImageModel: (single) => {
      set((state) => {
        state.filters.singleImageModel = single;
        single ? setCookie('g_singleImageModel', single) : deleteCookie('g_singleImageModel');
      });
    },
    setSingleImageAlbum: (single) => {
      set((state) => {
        state.filters.singleImageAlbum = single;
        single ? setCookie('g_singleImageAlbum', single) : deleteCookie('g_singleImageAlbum');
      });
    },
  }))
);

export const useGalleryFilters = (): {
  filters: Partial<QueryFilterProps> & FilterProps;
  clearFilters: VoidFunction;
} => {
  const router = useRouter();
  const cookies = useCookies().gallery;
  const limit = constants.galleryFilterDefaults.limit;
  const storeFilters = useFiltersStore((state) => state.filters);
  const filters = { ...storeFilters, limit };
  const result = queryStringSchema.safeParse(router.query);

  const setTypes = useFiltersStore((state) => state.setTypes);
  const setTags = useFiltersStore((state) => state.setTags);
  const setExcludedTags = useFiltersStore((state) => state.setExcludedTags);
  const setResources = useFiltersStore((state) => state.setResources);
  const setSingleImageModel = useFiltersStore((state) => state.setSingleImageModel);
  const setSingleImageAlbum = useFiltersStore((state) => state.setSingleImageAlbum);

  const clearFilters = () => {
    setTypes([]);
    setTags([]);
    setExcludedTags([]);
    setResources([]);
    setSingleImageModel(false);
    setSingleImageAlbum(false);
  };

  const combinedFilters = result.success
    ? { ...result.data, ...cookies, ...filters }
    : { ...cookies, ...filters };

  return {
    filters: combinedFilters,
    clearFilters,
  };
};

const sortOptions = Object.values(ImageSort);
export function GallerySort() {
  const cookies = useCookies().gallery;
  const setSort = useFiltersStore((state) => state.setSort);
  const sort = useFiltersStore(
    (state) => state.filters.sort ?? cookies.sort ?? constants.galleryFilterDefaults.sort
  );

  return (
    <SelectMenu
      label={sort}
      options={sortOptions.map((x) => ({ label: x, value: x }))}
      onClick={(sort) => setSort(sort)}
      value={sort}
    />
  );
}

const periodOptions = Object.values(MetricTimeframe);
export function GalleryPeriod() {
  const cookies = useCookies().gallery;
  const setPeriod = useFiltersStore((state) => state.setPeriod);
  const period = useFiltersStore(
    (state) => state.filters.period ?? cookies.period ?? constants.galleryFilterDefaults.period
  );

  return (
    <SelectMenu
      label={period && splitUppercase(period.toString())}
      options={periodOptions.map((option) => ({ label: splitUppercase(option), value: option }))}
      onClick={(period) => setPeriod(period)}
      value={period}
    />
  );
}

export function GalleryFilters() {
  const user = useCurrentUser();
  const defaultBrowsingMode = user?.showNsfw ? BrowsingMode.All : BrowsingMode.SFW;
  const { classes } = useStyles();
  const { clearFilters } = useGalleryFilters();
  const cookies = useCookies().gallery;
  const setTypes = useFiltersStore((state) => state.setTypes);
  const types = useFiltersStore((state) => state.filters.types ?? cookies.types ?? []);
  const setExcludedTags = useFiltersStore((state) => state.setExcludedTags);
  const excludedTags = useFiltersStore(
    (state) => state.filters.excludedTags ?? cookies.excludedTags ?? []
  );
  // const setResources = useFiltersStore((state) => state.setResources);
  const resources = useFiltersStore((state) => state.filters.resources ?? cookies.resources ?? []);
  // const setSingleImageModel = useFiltersStore((state) => state.setSingleImageModel);
  const singleImageModel = useFiltersStore(
    (state) => state.filters.singleImageModel ?? cookies.singleImageModel ?? false
  );
  // const setSingleImageAlbum = useFiltersStore((state) => state.setSingleImageAlbum);
  const singleImageAlbum = useFiltersStore(
    (state) => state.filters.singleImageAlbum ?? cookies.singleImageAlbum ?? false
  );
  const browsingMode = useFiltersStore(
    (state) => state.filters.browsingMode ?? cookies.browsingMode ?? defaultBrowsingMode
  );
  const setBrowsingMode = useFiltersStore((state) => state.setBrowsingMode);
  const showNSFWToggle = !user || user.showNsfw;

  useEffect(() => {
    if (browsingMode === undefined) setBrowsingMode(defaultBrowsingMode);
  }, [browsingMode, defaultBrowsingMode, setBrowsingMode]);

  const filterLength =
    types.length +
    resources.length +
    (browsingMode !== defaultBrowsingMode ? 1 : 0) +
    (excludedTags.length > 0 ? 1 : 0) +
    (singleImageModel ? 1 : 0) +
    (singleImageAlbum ? 1 : 0);

  const chipProps: Partial<ChipProps> = {
    radius: 'sm',
    classNames: { label: classes.label, iconWrapper: classes.iconWrapper },
  };

  const { data: { items: tags } = { items: [] } } = trpc.tag.getAll.useQuery(
    { entityType: ['Image'], categories: false, unlisted: false },
    { cacheTime: Infinity, staleTime: Infinity }
  );

  return (
    <Popover withArrow>
      <Popover.Target>
        <Indicator
          offset={4}
          label={filterLength ? filterLength : undefined}
          showZero={false}
          dot={false}
          size={16}
          inline
          zIndex={10}
        >
          <ActionIcon color="dark" variant="transparent" sx={{ width: 40 }}>
            <IconFilter size={20} stroke={2.5} />
            <IconChevronDown size={16} stroke={3} />
          </ActionIcon>
        </Indicator>
      </Popover.Target>
      <Popover.Dropdown maw={350} w="100%">
        <Stack spacing={4}>
          {showNSFWToggle && (
            <>
              <Divider label="Browsing Mode" labelProps={{ weight: 'bold' }} />
              <SegmentedControl
                my={5}
                value={browsingMode ?? 'SFW'}
                size="xs"
                color="blue"
                styles={(theme) => ({
                  root: {
                    border: `1px solid ${
                      theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[4]
                    }`,
                    background: 'none',
                  },
                })}
                data={[
                  { label: 'Safe', value: 'SFW' },
                  { label: 'Adult', value: 'NSFW' },
                  { label: 'Everything', value: 'All' },
                ]}
                onChange={(value) => {
                  setBrowsingMode(value as BrowsingMode, true);
                }}
              />
            </>
          )}
          <Divider label="Generation process" labelProps={{ weight: 'bold' }} />
          <Chip.Group
            spacing={4}
            value={types}
            onChange={(types: ImageGenerationProcess[]) => setTypes(types)}
            multiple
          >
            {Object.values(ImageGenerationProcess).map((type, index) => (
              <Chip key={index} value={type} {...chipProps}>
                {type === 'txt2imgHiRes' ? 'txt2img + hi-res' : type}
              </Chip>
            ))}
          </Chip.Group>
          <Divider label="Excluded tags" labelProps={{ weight: 'bold' }} />
          <MultiSelect
            placeholder="Select tags"
            defaultValue={excludedTags.map(String)}
            data={tags.map((tag) => ({ value: tag.id.toString(), label: tag.name }))}
            onChange={(tags) => setExcludedTags(tags.map(Number))}
            nothingFound="No tags found"
            limit={50}
            clearable
            searchable
          />
          {/* <Divider label="Include resources" labelProps={{ weight: 'bold' }} />
          <Chip.Group
            spacing={4}
            value={resources}
            onChange={(resources: ImageResource[]) => setResources(resources)}
            my={4}
          >
            {Object.values(ImageResource).map((resource, index) => (
              <Chip key={index} value={resource} {...chipProps}>
                {resource}
              </Chip>
            ))}
          </Chip.Group>
          <Divider label="Show single image" labelProps={{ weight: 'bold' }} />
          <Group spacing={4}>
            <Chip {...chipProps} checked={singleImageModel} onChange={setSingleImageModel}>
              Per model
            </Chip>
            <Chip {...chipProps} checked={singleImageAlbum} onChange={setSingleImageAlbum}>
              Per album
            </Chip>
          </Group> */}
          {filterLength > 0 && (
            <Button mt="xs" compact onClick={clearFilters} leftIcon={<IconFilterOff size={20} />}>
              Clear Filters
            </Button>
          )}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

export function GalleryCategories() {
  const { classes, cx, theme } = useStyles();
  const currentUser = useCurrentUser();

  const cookies = useCookies().gallery;
  const setTags = useFiltersStore((state) => state.setTags);
  const tags = useFiltersStore((state) => state.filters.tags ?? cookies.tags ?? []);

  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollPosition, setScrollPosition] = useState({ x: 0, y: 0 });

  const { data: hiddenTags } = trpc.user.getTags.useQuery(
    { type: 'Hide' },
    { enabled: !!currentUser }
  );

  const { data: { items: categories } = { items: [] } } = trpc.tag.getAll.useQuery(
    {
      entityType: ['Image'],
      sort: TagSort.MostImages,
      not: hiddenTags?.map((x) => x.id),
      unlisted: false,
      categories: true,
      limit: 100,
    },
    { enabled: !currentUser || hiddenTags !== undefined }
  );

  if (!categories.length) return null;

  const largerThanViewport =
    viewportRef.current && viewportRef.current.scrollWidth > viewportRef.current.offsetWidth;
  const atStart = scrollPosition.x === 0;
  const atEnd =
    viewportRef.current &&
    scrollPosition.x >= viewportRef.current.scrollWidth - viewportRef.current.offsetWidth - 1;

  const scrollLeft = () => viewportRef.current?.scrollBy({ left: -200, behavior: 'smooth' });
  const scrollRight = () => viewportRef.current?.scrollBy({ left: 200, behavior: 'smooth' });

  const handleCategoryClick = (id: number, shouldAdd: boolean) => {
    const hasTag = tags.includes(id);
    if (hasTag) setTags(tags.filter((x) => x !== id));
    else if (!shouldAdd && !hasTag) setTags([id]);
    else setTags([...tags, id]);
  };

  return (
    <ScrollArea
      viewportRef={viewportRef}
      className={classes.tagsContainer}
      type="never"
      onScrollPositionChange={setScrollPosition}
    >
      <Box className={cx(classes.leftArrow, atStart && classes.hidden)}>
        <ActionIcon
          className={classes.arrowButton}
          variant="transparent"
          radius="xl"
          onClick={scrollLeft}
        >
          <IconChevronLeft />
        </ActionIcon>
      </Box>
      <Group className={classes.tagsGroup} spacing={8} noWrap>
        {categories.map((tag) => {
          const active = tags.includes(tag.id);
          return (
            <Button
              key={tag.id}
              className={classes.tag}
              variant={active ? 'filled' : theme.colorScheme === 'dark' ? 'filled' : 'light'}
              color={active ? 'blue' : 'gray'}
              onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
                const shouldAdd = e.ctrlKey;
                handleCategoryClick(tag.id, shouldAdd);
              }}
              compact
            >
              {tag.name}
            </Button>
          );
        })}
      </Group>
      <Box className={cx(classes.rightArrow, (atEnd || !largerThanViewport) && classes.hidden)}>
        <ActionIcon
          className={classes.arrowButton}
          variant="transparent"
          radius="xl"
          onClick={scrollRight}
        >
          <IconChevronRight />
        </ActionIcon>
      </Box>
    </ScrollArea>
  );
}

const useStyles = createStyles((theme, _params, getRef) => {
  const ref = getRef('iconWrapper');

  return {
    label: {
      fontSize: 12,
      fontWeight: 500,
      '&[data-checked]': {
        '&, &:hover': {
          backgroundColor: theme.colors.blue[theme.fn.primaryShade()],
          color: theme.white,
        },

        [`& .${ref}`]: {
          color: theme.white,
        },
      },
    },

    iconWrapper: {
      ref,
    },

    tagsContainer: {
      position: 'relative',

      [theme.fn.largerThan('lg')]: {
        // marginLeft: theme.spacing.xl * -1.5, // -36px
        // marginRight: theme.spacing.xl * -1.5, // -36px
      },
    },
    tagsGroup: {
      [theme.fn.largerThan('lg')]: {
        // marginLeft: theme.spacing.xl * 1.5, // 36px
        // marginRight: theme.spacing.xl * 1.5, // 36px
      },
    },
    tag: {
      textTransform: 'uppercase',
    },
    title: {
      display: 'none',

      [theme.fn.largerThan('sm')]: {
        display: 'block',
      },
    },
    arrowButton: {
      '&:active': {
        transform: 'none',
      },
    },
    hidden: {
      display: 'none !important',
    },
    leftArrow: {
      display: 'none',
      position: 'absolute',
      left: 0,
      top: '50%',
      transform: 'translateY(-50%)',
      paddingRight: theme.spacing.xl,
      zIndex: 12,
      backgroundImage: theme.fn.gradient({
        from: theme.colorScheme === 'dark' ? theme.colors.dark[7] : 'white',
        to: 'transparent',
        deg: 90,
      }),

      [theme.fn.largerThan('md')]: {
        display: 'block',
      },
    },
    rightArrow: {
      display: 'none',
      position: 'absolute',
      right: 0,
      top: '50%',
      transform: 'translateY(-50%)',
      paddingLeft: theme.spacing.xl,
      zIndex: 12,
      backgroundImage: theme.fn.gradient({
        from: theme.colorScheme === 'dark' ? theme.colors.dark[7] : 'white',
        to: 'transparent',
        deg: 270,
      }),

      [theme.fn.largerThan('md')]: {
        display: 'block',
      },
    },
  };
});
