import {
  ProfileSection,
  ProfileSectionNoResults,
  ProfileSectionPreview,
  ProfileSectionProps,
  useProfileSectionStyles,
} from '~/components/Profile/ProfileSection';
import { useInView } from '~/hooks/useInView';
import { IconArrowRight, IconCategory } from '@tabler/icons-react';
import React, { useMemo } from 'react';
import { useDumbModelFilters, useQueryModels } from '~/components/Model/model.utils';
import { ModelSort } from '~/server/common/enums';
import { ModelCard } from '~/components/Cards/ModelCard';
import { Button, Loader, Stack, Text } from '@mantine/core';
import { NextLink } from '@mantine/next';
import Link from 'next/link';
import { ShowcaseGrid } from '~/components/Profile/Sections/ShowcaseGrid';

const MAX_MODELS_DISPLAY = 32; // 2 rows of 7

export const MyModelsSection = ({ user }: ProfileSectionProps) => {
  const { ref, inView } = useInView({
    delay: 100,
    triggerOnce: true,
  });

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

  if (isNullState && inView) {
    return null;
  }

  return (
    <div ref={ref} className={isNullState ? undefined : classes.profileSection}>
      {isLoading || !inView ? (
        <ProfileSectionPreview rowCount={2} />
      ) : (
        <ProfileSection
          title="Models"
          icon={<IconCategory />}
          action={
            !isRefetching && (
              <Link href={`/user/${user.username}/models?sort=${ModelSort.Newest}`} passHref>
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
      )}
    </div>
  );
};
