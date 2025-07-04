import type { ButtonProps } from '@mantine/core';
import { IconUsersGroup, IconWorld } from '@tabler/icons-react';
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

export function FollowedFilter(props: FollowFilterProps) {
  // Explicit type assertion because ts is dumb -Manuel
  if (typeof props.value === 'string') return <DumbFollowFilter {...props} />;
  return <StatefulFollowFilter {...props} type={props.type} />;
}

type DumbProps = {
  type: FollowFilterableTypes;
  value: string;
  onChange: (value: string) => void;
} & FollowFilterComponentProps;
function DumbFollowFilter({ type, value, onChange, ...props }: DumbProps) {
  const sharedProps = {
    label: value === 'true' ? 'Followed' : 'Everyone',
    options: [
      { label: 'Followed', value: 'true' },
      { label: 'Everyone', value: 'false' },
    ],
    onClick: onChange,
    value,
  };
  const followed = value === 'true';
  const { variant, ...buttonProps } = props.buttonProps ?? {};

  return (
    <SelectMenuV2 {...sharedProps} icon={followed ? IconUsersGroup : IconWorld} {...buttonProps} />
  );
}

type StatefulProps = {
  type: FollowFilterableTypes;
  value?: undefined;
  onChange?: undefined;
} & FollowFilterComponentProps;
function StatefulFollowFilter({ type, variant, ...props }: StatefulProps) {
  const { query, pathname, replace } = useRouter();
  const globalFollowed = useFiltersContext((state) => state[type].followed);
  const queryFollowed = query.followed as string | undefined;

  const setFilters = useSetFilters(type);
  const setFollowed = (followed: string) => {
    if (queryFollowed && queryFollowed !== followed)
      replace({ pathname, query: removeEmpty({ ...query, followed: undefined }) }, undefined, {
        shallow: true,
      });
    setFilters({ followed: followed === 'true' });
  };

  const followed = queryFollowed ? queryFollowed : globalFollowed?.toString() ?? 'false';
  return (
    <DumbFollowFilter
      type={type}
      value={followed}
      onChange={setFollowed}
      variant={variant}
      {...props}
    />
  );
}
