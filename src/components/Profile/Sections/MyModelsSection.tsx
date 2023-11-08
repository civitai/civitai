import {
  ProfileSection,
  ProfileSectionNoResults,
  ProfileSectionPreview,
  ProfileSectionProps,
  useProfileSectionStyles,
} from '~/components/Profile/ProfileSection';
import { useInView } from 'react-intersection-observer';
import { IconCategory } from '@tabler/icons-react';
import React, { useMemo } from 'react';
import { useDumbModelFilters, useQueryModels } from '~/components/Model/model.utils';
import { ModelSort } from '~/server/common/enums';
import { ModelCard } from '~/components/Cards/ModelCard';
import { Button, Center, Group, Loader, Stack } from '@mantine/core';
import { NextLink } from '@mantine/next';
import { PeriodFilter, SortFilter } from '~/components/Filters';
import { DumbModelFiltersDropdown } from '~/components/Model/Infinite/ModelFiltersDropdown';
import { CategoryTags } from '~/components/CategoryTags/CategoryTags';
import { ModelFilterSchema } from '~/providers/FiltersProvider';

const MAX_MODELS_DISPLAY = 12;
export const MyModelsSection = ({ user }: ProfileSectionProps) => {
  const { ref, inView } = useInView();

  const { filters } = useDumbModelFilters({
    period: 'AllTime',
    sort: ModelSort.Newest,
  });

  const {
    models: _models,
    isLoading,
    isRefetching,
  } = useQueryModels(
    {
      ...filters,
      username: user.username,
      limit: MAX_MODELS_DISPLAY + 1,
    },
    { keepPreviousData: true, enabled: inView }
  );

  const models = useMemo(() => _models.slice(0, MAX_MODELS_DISPLAY), [_models]);

  const { classes, cx } = useProfileSectionStyles({
    count: models.length,
    rowCount: 3,
    widthGrid: '280px',
  });

  const isNullState = !isLoading && !models.length;

  return (
    <div ref={ref} className={isNullState ? undefined : classes.profileSection}>
      {isNullState ? null : isLoading ? (
        <ProfileSectionPreview />
      ) : (
        <ProfileSection title="Models" icon={<IconCategory />}>
          <Stack>
            <div
              className={cx({
                [classes.grid]: models.length > 0,
                [classes.nullState]: !models.length,
                [classes.loading]: isRefetching,
              })}
            >
              {!models.length && <ProfileSectionNoResults />}
              {models.map((model) => (
                <ModelCard data={model} key={model.id} />
              ))}
              {isRefetching && <Loader className={classes.loader} />}
            </div>
            {!isRefetching && _models.length > MAX_MODELS_DISPLAY && (
              <Button
                href={`/user/${user.username}/models`}
                component={NextLink}
                rel="nofollow"
                size="md"
                display="inline-block"
                mr="auto"
              >
                View all models
              </Button>
            )}
          </Stack>
        </ProfileSection>
      )}
    </div>
  );
};
