import {
  ProfileSection,
  ProfileSectionNoResults,
  ProfileSectionPreview,
  ProfileSectionProps,
  useProfileSectionStyles,
} from '~/components/Profile/ProfileSection';
import { useInView } from 'react-intersection-observer';
import { IconArrowRight, IconCategory } from '@tabler/icons-react';
import React, { useMemo } from 'react';
import { useDumbModelFilters, useQueryModels } from '~/components/Model/model.utils';
import { ModelSort } from '~/server/common/enums';
import { ModelCard } from '~/components/Cards/ModelCard';
import { Button, Loader, Stack, Text } from '@mantine/core';
import { NextLink } from '@mantine/next';
import Link from 'next/link';

const MAX_MODELS_DISPLAY = 14; // 2 rows of 7

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
    rowCount: 3,
    widthGrid: '280px',
  });

  const isNullState = !isLoading && !models.length;

  if (isNullState && inView) {
    return null;
  }

  return (
    <div ref={ref} className={isNullState ? undefined : classes.profileSection}>
      {isLoading || !inView ? (
        <ProfileSectionPreview />
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
          </Stack>
        </ProfileSection>
      )}
    </div>
  );
};
