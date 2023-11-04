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
  const { ref, inView } = useInView();
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
    rowCount: 1,
    columnCount: 5,
    widthGrid: 'auto',
  });

  const isNullState = showcaseItems.length === 0 || (!isLoading && !coverImages.length);

  return (
    <div ref={ref}>
      {isNullState ? null : isLoading ? (
        <ProfileSectionPreview />
      ) : (
        <ProfileSection title="Showcase" icon={<IconHeart />}>
          <div
            className={cx({
              [classes.grid]: coverImages.length > 0,
              [classes.nullState]: !coverImages.length,
              [classes.loading]: isRefetching,
            })}
          >
            {coverImages.map((image) => (
              <GenericImageCard
                image={image}
                entityId={image.entityId}
                entityType={image.entityType}
                key={image.id}
              />
            ))}
          </div>
        </ProfileSection>
      )}
    </div>
  );
};
