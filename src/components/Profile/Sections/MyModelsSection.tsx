import type { ProfileSectionProps } from '~/components/Profile/ProfileSection';
import {
  ProfileSection,
  ProfileSectionNoResults,
  ProfileSectionPreview,
  useProfileSectionStyles,
} from '~/components/Profile/ProfileSection';
import { useInView } from '~/hooks/useInView';
import { IconArrowRight, IconCategory } from '@tabler/icons-react';
import React, { useMemo } from 'react';
import { useDumbModelFilters, useQueryModels } from '~/components/Model/model.utils';
import { ModelSort } from '~/server/common/enums';
import { ModelCard } from '~/components/Cards/ModelCard';
import { Button, Loader, Stack, Text } from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { ShowcaseGrid } from '~/components/Profile/Sections/ShowcaseGrid';
import { useInViewDynamic } from '~/components/IntersectionObserver/IntersectionObserverProvider';

const MAX_MODELS_DISPLAY = 32; // 2 rows of 7

export const MyModelsSection = ({ user }: ProfileSectionProps) => {
  const [ref, inView] = useInViewDynamic({ id: 'profile-models-section' });

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
      limit: 2 * MAX_MODELS_DISPLAY,
    },
    { keepPreviousData: true, enabled: inView }
  );

  const models = useMemo(() => _models.slice(0, MAX_MODELS_DISPLAY), [_models]);

  const { classes, cx } = useProfileSectionStyles({
    count: models.length,
    rowCount: 2,
    widthGrid: '280px',
  });

  const isNullState = !isLoading && !models.length;

  if (isNullState) {
    return null;
  }

  return (
    <div ref={ref} className={isNullState ? undefined : classes.profileSection}>
      {inView &&
        (isLoading ? (
          <ProfileSectionPreview rowCount={2} />
        ) : (
          <ProfileSection
            title="Models"
            icon={<IconCategory />}
            action={
              !isRefetching && (
                <Link
                  legacyBehavior
                  href={`/user/${user.username}/models?sort=${ModelSort.Newest}`}
                  passHref
                >
                  <Button
                    h={34}
                    component="a"
                    variant="subtle"
                    rightIcon={<IconArrowRight size={16} />}
                  >
                    <Text inherit> View all models</Text>
                  </Button>
                </Link>
              )
            }
          >
            <ShowcaseGrid
              itemCount={models.length}
              rows={2}
              className={cx({
                [classes.nullState]: !models.length,
                [classes.loading]: isRefetching,
              })}
            >
              {!models.length && <ProfileSectionNoResults />}
              {models.map((model) => (
                <ModelCard data={model} key={model.id} />
              ))}
              {isRefetching && <Loader className={classes.loader} />}
            </ShowcaseGrid>
          </ProfileSection>
        ))}
    </div>
  );
};
