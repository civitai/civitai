import type { ProfileSectionProps } from '~/components/Profile/ProfileSection';
import { ProfileSection, ProfileSectionPreview } from '~/components/Profile/ProfileSection';
import classes from '~/components/Profile/ProfileSection.module.css';

import { useInView } from '~/hooks/useInView';
import { IconArrowRight, IconTrendingUp } from '@tabler/icons-react';
import React from 'react';
import { useQueryModels } from '~/components/Model/model.utils';
import { ModelSort } from '~/server/common/enums';
import { ModelCard } from '~/components/Cards/ModelCard';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { Button, Text } from '@mantine/core';
import { ShowcaseGrid } from '~/components/Profile/Sections/ShowcaseGrid';
import { useInViewDynamic } from '~/components/IntersectionObserver/IntersectionObserverProvider';

const POPULAR_MODELS_DISPLAY = 32;

export const PopularModelsSection = ({ user }: ProfileSectionProps) => {
  const [ref, inView] = useInViewDynamic({ id: 'profile-popular-models-section' });
  const { models, isLoading } = useQueryModels(
    {
      limit: POPULAR_MODELS_DISPLAY,
      username: user.username,
      sort: ModelSort.HighestRated,
    },
    { keepPreviousData: true, enabled: inView }
  );

  const isNullState = !isLoading && !models.length;

  if (isNullState) {
    return null;
  }

  return (
    <div
      ref={ref}
      className={isNullState ? undefined : classes.profileSection}
      style={
        {
          '--count': models.length,
          '--row-count': 2,
          '--width-grid': '280px',
        } as React.CSSProperties
      }
    >
      {inView &&
        (isLoading ? (
          <ProfileSectionPreview rowCount={2} />
        ) : (
          <ProfileSection
            title="Most popular models"
            icon={<IconTrendingUp />}
            action={
              <Link
                legacyBehavior
                href={`/user/${user.username}/models?sort=${ModelSort.HighestRated}`}
                passHref
              >
                <Button
                  h={34}
                  component="a"
                  variant="subtle"
                  rightSection={<IconArrowRight size={16} />}
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
        ))}
    </div>
  );
};
