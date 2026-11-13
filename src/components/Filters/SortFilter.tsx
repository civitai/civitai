import type { ButtonProps } from '@mantine/core';
import { useRouter } from 'next/router';
import { HatIcon } from '~/components/HatTurf/HatIcon';
import { useHatTurfFeedPlayer } from '~/components/HatTurf/useHatTurfFeedPlayer';
import { isSortAvailable, resolveFeedSort } from '~/components/Filters/sort-availability';
import { useSortAvailability } from '~/components/Filters/useSortAvailability';
import { SelectMenuV2 } from '~/components/SelectMenu/SelectMenu';
import type { FilterSubTypes } from '~/providers/FiltersProvider';
import { useFiltersContext, useSetFilters } from '~/providers/FiltersProvider';
import {
  ArticleSort,
  ArticleSortHidden,
  BountySort,
  BuzzWithdrawalRequestSort,
  CollectionSort,
  CrucibleSort,
  GenerationSort,
  ImageSort,
  ImageSortHidden,
  ModelSort,
  ModelSortHidden,
  PostSort,
  PostSortHidden,
  ThreadSort,
  ToolSort,
} from '~/server/common/enums';
import {
  HAT_SORT_LABELS,
  HAT_SORTS,
  type HatSort,
} from '~/shared/constants/hat-turf-feed.constants';
import { removeEmpty } from '~/utils/object-helpers';

type SortFilterComponentProps = {
  type: Exclude<FilterSubTypes, 'changelogs' | 'auctions'>;
  ignoreNsfwLevel?: boolean;
  options?: { label: SortOption; value: SortOption }[];
  /** Only the sort icon, for a tight row. */
  iconOnly?: boolean;
} & Omit<ButtonProps, 'children' | 'type' | 'style'>;

type SortFilterProps = StatefulProps | DumbProps;

const sortOptions = {
  models: Object.values(ModelSort).filter((x) => !Object.values(ModelSortHidden).includes(x)),
  posts: Object.values(PostSort).filter((x) => !Object.values(PostSortHidden).includes(x)),
  images: Object.values(ImageSort).filter((x) => !Object.values(ImageSortHidden).includes(x)),
  modelImages: Object.values(ImageSort).filter((x) => !Object.values(ImageSortHidden).includes(x)),
  articles: Object.values(ArticleSort).filter((x) => !Object.values(ArticleSortHidden).includes(x)),
  collections: Object.values(CollectionSort),
  bounties: Object.values(BountySort),
  videos: Object.values(ImageSort).filter((x) => !Object.values(ImageSortHidden).includes(x)),
  threads: Object.values(ThreadSort),
  generation: Object.values(GenerationSort),
  tools: Object.values(ToolSort),
  buzzWithdrawalRequests: Object.values(BuzzWithdrawalRequestSort),
  crucibles: Object.values(CrucibleSort),
};

export function SortFilter(props: SortFilterProps) {
  if ('value' in props) return <DumbSortFilter {...props} />;
  return <StatefulSortFilter {...props} type={props.type} />;
}

type SortOption =
  | ModelSort
  | PostSort
  | ImageSort
  | ArticleSort
  | CollectionSort
  | BountySort
  | GenerationSort
  | ThreadSort
  | ToolSort
  | BuzzWithdrawalRequestSort
  | CrucibleSort;

type DumbProps = {
  // Dumb props should work without needing to create a full filter attribute.
  value: SortOption;
  onChange: (value: SortOption) => void;
  /** The image feed's Hat Turf sorts, for players: the one picked, or null for none. */
  hat?: { value: HatSort | null; onChange: (value: HatSort) => void };
} & SortFilterComponentProps;

const HAT_GROUP = {
  id: 'hat-turf',
  label: (
    <span className="inline-flex items-center gap-1">
      <HatIcon size={14} /> Hat Turf
    </span>
  ),
};
const hatOption = (sort: HatSort) => `hat:${sort}`;

function DumbSortFilter({
  type,
  value,
  onChange,
  hat,
  ignoreNsfwLevel,
  options,
  ...props
}: DumbProps) {
  const availability = useSortAvailability();
  // The menu below drops what this viewer may not sort by, so a value outside it
  // would label the control with a sort its own menu will not offer.
  const resolved = resolveFeedSort({ type, value }, { ...availability, ignoreNsfwLevel });
  const sorts: { label: string; value: string; group?: typeof HAT_GROUP }[] = (
    options ?? sortOptions[type].map((x) => ({ label: x, value: x }))
  ).filter((x) => isSortAvailable({ type, value: x.value }, { ...availability, ignoreNsfwLevel }));
  if (hat)
    sorts.push(
      ...HAT_SORTS.map((sort) => ({
        label: HAT_SORT_LABELS[sort],
        value: hatOption(sort),
        group: HAT_GROUP,
      }))
    );
  const label = hat?.value ? HAT_SORT_LABELS[hat.value] : resolved;

  return (
    <SelectMenuV2
      label={props.iconOnly ? `Sort: ${label}` : label}
      onClick={(picked: string) => {
        const sort = HAT_SORTS.find((s) => hatOption(s) === picked);
        if (sort && hat) hat.onChange(sort);
        else onChange(picked as SortOption);
      }}
      value={hat?.value ? hatOption(hat.value) : resolved}
      options={sorts}
      {...props}
    />
  );
}

type StatefulProps = SortFilterComponentProps;

function StatefulSortFilter({ type, ...props }: StatefulProps) {
  const { query, pathname, replace } = useRouter();
  const globalSort = useFiltersContext((state) => state[type].sort);
  const querySort = query.sort as typeof globalSort | undefined;

  const setFilters = useSetFilters(type);
  const setSort = (sort: typeof globalSort) => {
    if (querySort && querySort !== sort)
      replace({ pathname, query: removeEmpty({ ...query, sort: undefined }) }, undefined, {
        shallow: true,
      });
    setFilters({ sort: sort as any });
  };

  const sort = querySort ? querySort : globalSort;
  if (type === 'images') return <ImageSortFilter value={sort} onChange={setSort} {...props} />;
  return <DumbSortFilter type={type} value={sort} onChange={setSort} {...props} />;
}

/** The image feed's sorts, with Hat Turf's for players. A Hat Turf sort, while picked, wins. */
function ImageSortFilter({ onChange, ...props }: Omit<DumbProps, 'type' | 'hat'>) {
  const player = useHatTurfFeedPlayer();
  const hatSort = useFiltersContext((state) => state.images.hatSort);
  const setFilters = useSetFilters('images');
  return (
    <DumbSortFilter
      type="images"
      onChange={(sort) => {
        onChange(sort);
        setFilters({ hatSort: undefined });
      }}
      hat={
        player
          ? { value: hatSort ?? null, onChange: (value) => setFilters({ hatSort: value }) }
          : undefined
      }
      {...props}
    />
  );
}
