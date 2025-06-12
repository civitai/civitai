import type { ProfileSectionProps } from '~/components/Profile/ProfileSection';
import {
  ProfileSection,
  ProfileSectionPreview,
} from '~/components/Profile/ProfileSection';
import { IconHeart } from '@tabler/icons-react';
import React, { useMemo } from 'react';
import type { ShowcaseItemSchema } from '~/server/schema/user-profile.schema';
import { trpc } from '~/utils/trpc';
import { GenericImageCard } from '~/components/Cards/GenericImageCard';
import { ShowcaseGrid } from '~/components/Profile/Sections/ShowcaseGrid';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { useInViewDynamic } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import classes from '~/components/Profile/ProfileSection.module.css';
import clsx from 'clsx';

export const ShowcaseSection = ({ user }: ProfileSectionProps) => {
  const [ref, inView] = useInViewDynamic({ id: 'profile-showcase-section' });
  const showcaseItems = user.profile.showcaseItems as ShowcaseItemSchema[];
  const {
    data: _coverImages,
    isLoading,
    isRefetching,
  } = trpc.image.getEntitiesCoverImage.useQuery(
    { entities: showcaseItems },
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

  const isNullState = showcaseItems.length === 0 || (!isLoading && !coverImages.length);

  if (isNullState) {
    return null;
  }

  return (
    <div
      ref={ref}
      className={isNullState ? undefined : classes.profileSection}
      style={
        {
          '--count': showcaseItems.length,
          '--row-count': 2,
          '--width-grid': '280px',
        } as React.CSSProperties
      }
    >
      {inView &&
        (isLoading ? (
          <ProfileSectionPreview rowCount={2} />
        ) : (
          <ProfileSection title="Showcase" icon={<IconHeart />}>
            <ShowcaseGrid
              itemCount={showcaseItems.length}
              rows={2}
              className={clsx({
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
        ))}
    </div>
  );
};
