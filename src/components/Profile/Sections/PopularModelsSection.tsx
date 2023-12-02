import {
  ProfileSection,
  ProfileSectionPreview,
  ProfileSectionProps,
  useProfileSectionStyles,
} from '~/components/Profile/ProfileSection';
import { useInView } from '~/hooks/useInView';
import { IconArrowRight, IconTrendingUp } from '@tabler/icons-react';
import React from 'react';
import { useQueryModels } from '~/components/Model/model.utils';
import { ModelSort } from '~/server/common/enums';
import { ModelCard } from '~/components/Cards/ModelCard';
import Link from 'next/link';
import { Button, Text } from '@mantine/core';
import { ShowcaseGrid } from '~/components/Profile/Sections/ShowcaseGrid';

const POPULAR_MODELS_DISPLAY = 32;

export const PopularModelsSection = ({ user }: ProfileSectionProps) => {
  const { ref, inView } = useInView({
    delay: 100,
    triggerOnce: true,
  });
  const { models, isLoading } = useQueryModels(
    {
      limit: POPULAR_MODELS_DISPLAY,
      username: user.username,
      sort: ModelSort.HighestRated,
    },
    { keepPreviousData: true, enabled: inView }
  );

  const { classes } = useProfileSectionStyles({
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
          title="Most popular models"
          icon={<IconTrendingUp />}
          action={
            <Link href={`/user/${user.username}/models?sort=${ModelSort.HighestRated}`} passHref>
              <Button
                h={34}
                component="a"
                variant="subtle"
                rightIcon={<IconArrowRight size={16} />}
              >
                <Text inherit> View all models</Text>
              </Button>
            </Link>
          }
        >
          <ShowcaseGrid itemCount={models.length} rows={2}>
            {models.map((model) => (
              <ModelCard data={model} key={model.id} />
            ))}
          </ShowcaseGrid>
        </ProfileSection>
      )}
    </div>
  );
};
