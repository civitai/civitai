import {
  ProfileSection,
  ProfileSectionPreview,
  ProfileSectionProps,
  useProfileSectionStyles,
} from '~/components/Profile/ProfileSection';
import { useInView } from '~/hooks/useInView';
import { IconHeart } from '@tabler/icons-react';
import React, { useMemo } from 'react';
import { ShowcaseItemSchema } from '~/server/schema/user-profile.schema';
import { trpc } from '~/utils/trpc';
import { GenericImageCard } from '~/components/Cards/GenericImageCard';
import { ShowcaseGrid } from '~/components/Profile/Sections/ShowcaseGrid';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';

export const ShowcaseSection = ({ user }: ProfileSectionProps) => {
  const { ref, inView } = useInView({
    delay: 100,
    triggerOnce: true,
  });
  const showcaseItems = user.profile.showcaseItems as ShowcaseItemSchema[];
  const {
    data: _coverImages,
    isLoading,
    isRefetching,
  } = trpc.image.getEntitiesCoverImage.useQuery(
    {
      entities: showcaseItems,
    },
    {
      enabled: showcaseItems.length > 0 && inView,
      keepPreviousData: true,
      trpc: { context: { skipBatch: true } },
    }
  );

  const transformed = useMemo(
    () =>
      _coverImages?.map((image) => ({
        ...image,
        tagIds: image.tags?.map((x) => x.id),
      })) ?? [],
    [_coverImages]
  );

  const { items: coverImages } = useApplyHiddenPreferences({
    type: 'images',
    data: transformed,
  });

  const { classes, cx } = useProfileSectionStyles({
    // count: coverImages.length,
    count: showcaseItems.length,
    rowCount: 2,
    widthGrid: '280px',
  });

  const isNullState = showcaseItems.length === 0 || (!isLoading && !coverImages.length);

  if (isNullState && inView) {
    return null;
  }

  return (
    <div ref={ref} className={isNullState ? undefined : classes.profileSection}>
      {isLoading || !inView ? (
        <ProfileSectionPreview rowCount={2} />
      ) : (
        <ProfileSection title="Showcase" icon={<IconHeart />}>
          <ShowcaseGrid
            itemCount={showcaseItems.length}
            rows={2}
            className={cx({
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
          </ShowcaseGrid>
        </ProfileSection>
      )}
    </div>
  );
};
