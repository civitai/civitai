import {
  ProfileSection,
  ProfileSectionPreview,
  ProfileSectionProps,
  useProfileSectionStyles,
} from '~/components/Profile/ProfileSection';
import { useInView } from 'react-intersection-observer';
import { IconHeart } from '@tabler/icons-react';
import React from 'react';
import { ShowcaseItemSchema } from '~/server/schema/user-profile.schema';
import { trpc } from '~/utils/trpc';
import { GenericImageCard } from '~/components/Cards/GenericImageCard';

export const ShowcaseSection = ({ user }: ProfileSectionProps) => {
  const { ref, inView } = useInView({
    delay: 100,
    triggerOnce: true,
  });
  const showcaseItems = user.profile.showcaseItems as ShowcaseItemSchema[];
  const {
    data: coverImages = [],
    isLoading,
    isRefetching,
  } = trpc.image.getEntitiesCoverImage.useQuery(
    {
      entities: showcaseItems,
    },
    {
      enabled: showcaseItems.length > 0 && inView,
      keepPreviousData: true,
    }
  );

  const { classes, cx } = useProfileSectionStyles({
    // count: coverImages.length,
    count: showcaseItems.length,
    widthCarousel: '280px',
  });

  const isNullState = showcaseItems.length === 0 || (!isLoading && !coverImages.length);

  if (isNullState && inView) {
    return null;
  }

  return (
    <div ref={ref} className={isNullState ? undefined : classes.profileSection}>
      {isLoading || !inView ? (
        <ProfileSectionPreview />
      ) : (
        <ProfileSection title="Showcase" icon={<IconHeart />}>
          <div
            className={cx({
              [classes.scrollGrid]: coverImages.length > 0,
              [classes.nullState]: !coverImages.length,
              [classes.loading]: isRefetching,
            })}
          >
            {coverImages.map((image) => (
              <GenericImageCard
                image={image}
                entityId={image.entityId}
                entityType={image.entityType}
                key={`${image.entityType}-${image.entityId}`}
              />
            ))}
          </div>
        </ProfileSection>
      )}
    </div>
  );
};
