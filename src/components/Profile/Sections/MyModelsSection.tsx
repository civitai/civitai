import {
  ProfileSection,
  ProfileSectionPreview,
  useProfileSectionStyles,
} from '~/components/Profile/ProfileSection';
import { useInView } from 'react-intersection-observer';
import { IconApiApp } from '@tabler/icons-react';
import React, { useMemo, useState } from 'react';
import { useQueryModels } from '~/components/Model/model.utils';
import { ModelSort } from '~/server/common/enums';
import { ModelCard } from '~/components/Cards/ModelCard';
import { Button, Group } from '@mantine/core';
import { NextLink } from '@mantine/next';
import { PeriodFilter, SortFilter } from '~/components/Filters';
import { DumbModelFiltersDropdown } from '~/components/Model/Infinite/ModelFiltersDropdown';
import { DumbCategoryTags } from '~/components/CategoryTags/CategoryTags';
import { GetAllModelsInput } from '~/server/schema/model.schema';
import { ModelFilterSchema } from '~/providers/FiltersProvider';

const MAX_MODELS_DISPLAY = 12;
const INITIAL_FILTER: Partial<Omit<GetAllModelsInput, 'page'> & ModelFilterSchema> = {
  period: 'AllTime',
  sort: ModelSort.Newest,
};
export const MyModelsSection = ({ user }: { user: { id: number; username: string } }) => {
  const { ref, inView } = useInView();
  const [filters, setFilters] = useState<Partial<Omit<GetAllModelsInput, 'page'>>>(INITIAL_FILTER);
  const { period, sort } = filters;
  const { models: _models, isLoading } = useQueryModels(
    {
      ...filters,
      username: user.username,
      limit: MAX_MODELS_DISPLAY + 1,
    },
    { keepPreviousData: true, enabled: inView }
  );

  const models = useMemo(() => _models.slice(0, MAX_MODELS_DISPLAY), [_models]);

  const { classes } = useProfileSectionStyles({
    count: models.length,
    rowCount: 3,
  });

  if (inView && !isLoading && !models.length && filters === INITIAL_FILTER) {
    // No point in showing this without models
    return null;
  }

  return (
    <div ref={ref}>
      {isLoading ? (
        <ProfileSectionPreview />
      ) : (
        <ProfileSection title="Models" icon={<IconApiApp />}>
          <Group position="apart" spacing={0}>
            <SortFilter
              type="models"
              value={sort as ModelSort}
              onChange={(x) => setFilters((f) => ({ ...f, sort: x as ModelSort }))}
            />
            <Group spacing="xs">
              <PeriodFilter
                type="models"
                value={period ?? 'AllTime'}
                onChange={(x) => setFilters((f) => ({ ...f, period: x }))}
              />
              <DumbModelFiltersDropdown
                filters={filters as ModelFilterSchema}
                setFilters={(updatedFilters) => setFilters((f) => ({ ...f, ...updatedFilters }))}
              />
            </Group>
          </Group>
          <DumbCategoryTags
            onChange={(data) => setFilters((f) => ({ ...f, tag: data.tag }))}
            tag={filters.tag}
          />
          <div className={classes.grid}>
            {models.map((model) => (
              <ModelCard data={model} key={model.id} />
            ))}
          </div>
          {_models.length > MAX_MODELS_DISPLAY && (
            <Button
              href={`/user/${user.username}/profile/models`}
              component={NextLink}
              rel="nofollow"
              size="md"
              display="inline-block"
              mr="auto"
            >
              View all models
            </Button>
          )}
        </ProfileSection>
      )}
    </div>
  );
};
