import { keepPreviousData } from '@tanstack/react-query';
import type { ProfileSectionProps } from '~/components/Profile/ProfileSection';
import { ProfileSection, ProfileSectionPreview } from '~/components/Profile/ProfileSection';
import { IconHeart } from '@tabler/icons-react';
import React, { useMemo } from 'react';
import { MAX_ENTITIES_COVER_IMAGE } from '~/server/schema/image.schema';
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
  // Clamped to the schema's own bound rather than sent whole. `isNullState` below is
  // computed from `!coverImages.length`, so a refused query would take the entire
  // Showcase section off the profile — and it would stay off, since each render sends
  // the same list. Clamped, a showcase longer than the bound just shows its first
  // `MAX_ENTITIES_COVER_IMAGE` items. `addEntityToShowcase` truncates to 32, but
  // `userProfile.update` does not bound `showcaseItems`, so a stored showcase is not
  // guaranteed to be short.
  const entities = useMemo(() => showcaseItems.slice(0, MAX_ENTITIES_COVER_IMAGE), [showcaseItems]);
  const {
    data: _coverImages,
    isLoading,
    isRefetching,
  } = trpc.image.getEntitiesCoverImage.useQuery(
    { entities },
    {
      enabled: entities.length > 0 && inView,
      placeholderData: keepPreviousData,
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
