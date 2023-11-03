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
  const { ref, inView } = useInView();
  const { models, isLoading } = useQueryModels(
    {
      limit: 8,
      username: user.username,
      sort: ModelSort.HighestRated,
    },
    { keepPreviousData: true, enabled: inView }
  );

  const { classes } = useProfileSectionStyles({ count: models.length });

  if (inView && !isLoading && !models.length) {
    // No point in showing this without models
    return null;
  }

  return (
    <div ref={ref}>
      {isLoading ? (
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
