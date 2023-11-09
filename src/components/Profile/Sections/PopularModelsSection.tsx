import {
  ProfileSection,
  ProfileSectionPreview,
  ProfileSectionProps,
  useProfileSectionStyles,
} from '~/components/Profile/ProfileSection';
import { useInView } from 'react-intersection-observer';
import { IconTrendingUp } from '@tabler/icons-react';
import React from 'react';
import { useQueryModels } from '~/components/Model/model.utils';
import { ModelSort } from '~/server/common/enums';
import { ModelCard } from '~/components/Cards/ModelCard';

export const PopularModelsSection = ({ user }: ProfileSectionProps) => {
  const { ref, inView } = useInView({
    delay: 100,
    triggerOnce: true,
  });
  const { models, isLoading } = useQueryModels(
    {
      limit: 15,
      username: user.username,
      sort: ModelSort.HighestRated,
    },
    { keepPreviousData: true, enabled: inView }
  );

  const { classes } = useProfileSectionStyles({ count: models.length });

  const isNullState = !isLoading && !models.length;

  if (isNullState && inView) {
    return null;
  }

  return (
    <div ref={ref} className={isNullState ? undefined : classes.profileSection}>
      {isLoading || !inView ? (
        <ProfileSectionPreview />
      ) : (
        <ProfileSection title="Most popular models" icon={<IconTrendingUp />}>
          <div className={classes.scrollGrid}>
            {models.map((model) => (
              <ModelCard data={model} key={model.id} />
            ))}
          </div>
        </ProfileSection>
      )}
    </div>
  );
};
