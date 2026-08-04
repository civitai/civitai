import type { ButtonProps } from '@mantine/core';
import { IconSparkles, IconUsersGroup, IconWorld } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { SelectMenuV2 } from '~/components/SelectMenu/SelectMenu';
import { useFiltersContext, useSetFilters } from '~/providers/FiltersProvider';
import { removeEmpty } from '~/utils/object-helpers';

type FollowFilterButtonProps = {
  variant: 'button';
  buttonProps?: Omit<ButtonProps, 'style'>;
};
type FollowFilterComponentProps = FollowFilterButtonProps;

type FollowFilterProps = StatefulProps | DumbProps;
type FollowFilterableTypes = 'images' | 'models' | 'posts' | 'articles' | 'videos';

// Feeds whose server side resolves a "new & upcoming" creator set. Posts and
// articles have no board behind them, so they keep the two-option selector.
const NEW_CREATOR_TYPES: FollowFilterableTypes[] = ['images', 'videos', 'models'];

// A third audience alongside 'true'/'false' rather than a separate control: these
// are mutually exclusive views of the same feed, and the existing `followed`
// boolean is load-bearing across five feed types — widening it to an enum would
// touch far more than this feature.
const NEW_CREATORS_VALUE = 'new';

export function FollowedFilter(props: FollowFilterProps) {
  // Explicit type assertion because ts is dumb -Manuel
  if (typeof props.value === 'string') return <DumbFollowFilter {...props} />;
  return <StatefulFollowFilter {...props} type={props.type} />;
}

const labels: Record<string, string> = {
  true: 'Followed',
  false: 'Everyone',
  [NEW_CREATORS_VALUE]: 'New & Upcoming',
};

type DumbProps = {
  type: FollowFilterableTypes;
  value: string;
  onChange: (value: string) => void;
} & FollowFilterComponentProps;
function DumbFollowFilter({ type, value, onChange, ...props }: DumbProps) {
  const sharedProps = {
    label: labels[value] ?? labels.false,
    options: [
      { label: labels.true, value: 'true' },
      ...(NEW_CREATOR_TYPES.includes(type)
        ? [{ label: labels[NEW_CREATORS_VALUE], value: NEW_CREATORS_VALUE }]
        : []),
      { label: labels.false, value: 'false' },
    ],
    onClick: onChange,
    value,
  };
  const icon =
    value === NEW_CREATORS_VALUE ? IconSparkles : value === 'true' ? IconUsersGroup : IconWorld;
  const { variant, ...buttonProps } = props.buttonProps ?? {};

  return <SelectMenuV2 {...sharedProps} icon={icon} {...buttonProps} />;
}

type StatefulProps = {
  type: FollowFilterableTypes;
  value?: undefined;
  onChange?: undefined;
} & FollowFilterComponentProps;
function StatefulFollowFilter({ type, variant, ...props }: StatefulProps) {
  const { query, pathname, replace } = useRouter();
  const globalFollowed = useFiltersContext((state) => state[type].followed);
  // Only the feed types in NEW_CREATOR_TYPES carry this key; posts/articles don't.
  const globalNewCreators = useFiltersContext((state) =>
    'newCreators' in state[type] ? state[type].newCreators : undefined
  );
  const queryFollowed = query.followed as string | undefined;
  const queryNewCreators = query.newCreators as string | undefined;

  const setFilters = useSetFilters(type);
  const setAudience = (value: string) => {
    // A URL param would otherwise keep overriding the store on every render, so
    // drop both params once the user picks from the menu.
    if (
      (queryFollowed && queryFollowed !== value) ||
      (queryNewCreators && value !== NEW_CREATORS_VALUE)
    )
      replace(
        {
          pathname,
          query: removeEmpty({ ...query, followed: undefined, newCreators: undefined }),
        },
        undefined,
        { shallow: true }
      );
    setFilters({ followed: value === 'true', newCreators: value === NEW_CREATORS_VALUE });
  };

  const audience =
    queryNewCreators === 'true' || (!queryFollowed && !queryNewCreators && globalNewCreators)
      ? NEW_CREATORS_VALUE
      : queryFollowed ?? globalFollowed?.toString() ?? 'false';

  return (
    <DumbFollowFilter
      type={type}
      value={audience}
      onChange={setAudience}
      variant={variant}
      {...props}
    />
  );
}
