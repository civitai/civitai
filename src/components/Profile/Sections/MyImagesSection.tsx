import { Button, Loader, Text } from '@mantine/core';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import { IconArrowRight, IconPhoto } from '@tabler/icons-react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import React, { useMemo } from 'react';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { ImageCard } from '~/components/Cards/ImageCard';
import { useDumbImageFilters, useQueryImages } from '~/components/Image/image.utils';
import { ImagesProvider } from '~/components/Image/Providers/ImagesProvider';
import { useInViewDynamic } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import type { ProfileSectionProps } from '~/components/Profile/ProfileSection';
import {
  ProfileSection,
  ProfileSectionNoResults,
  ProfileSectionPreview,
} from '~/components/Profile/ProfileSection';
import { ShowcaseGrid } from '~/components/Profile/Sections/ShowcaseGrid';
import { ImageSort } from '~/server/common/enums';
import classes from '~/components/Profile/ProfileSection.module.css';
import clsx from 'clsx';

const MAX_IMAGES_DISPLAY = 32; // 2 rows of 7

export const MyImagesSection = ({ user }: ProfileSectionProps) => {
  const [ref, inView] = useInViewDynamic({ id: 'profile-images-section' });
  const { filters } = useDumbImageFilters({
    sort: ImageSort.Newest,
    period: MetricTimeframe.AllTime,
    tags: [],
  });

  const browsingLevel = useBrowsingLevelDebounced();
  const {
    images: _images,
    isLoading,
    isRefetching,
  } = useQueryImages(
    {
      ...filters,
      limit: 2 * MAX_IMAGES_DISPLAY,
      userId: user.id,
      withMeta: false,
      types: undefined,
      include: ['profilePictures', 'cosmetics'],
      browsingLevel,
      useIndex: true,
      notPublished: false,
    },
    { keepPreviousData: true, enabled: inView }
  );

  const images = useMemo(() => _images.slice(0, MAX_IMAGES_DISPLAY), [_images]);

  const isNullState = !isLoading && !images.length;

  if (isNullState) {
    return null;
  }

  return (
    <div
      ref={ref}
      className={isNullState ? undefined : classes.profileSection}
      style={
        {
          '--count': images.length,
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
            title="Images"
            icon={<IconPhoto />}
            action={
              !isRefetching && (
                <Link
                  legacyBehavior
                  href={`/user/${user.username}/images?sort=${ImageSort.Newest}`}
                  passHref
                >
                  <Button
                    h={34}
                    component="a"
                    variant="subtle"
                    rightSection={<IconArrowRight size={16} />}
                  >
                    <Text inherit> View all images</Text>
                  </Button>
                </Link>
              )
            }
          >
            <ShowcaseGrid
              itemCount={images.length}
              rows={2}
              className={clsx({
                [classes.nullState]: !images.length,
                [classes.loading]: isRefetching,
              })}
            >
              {!images.length && <ProfileSectionNoResults />}

              <ImagesProvider images={images}>
                {images.map((image) => (
                  <ImageCard data={image} key={image.id} />
                ))}
              </ImagesProvider>
              {isRefetching && <Loader className={classes.loader} />}
            </ShowcaseGrid>
          </ProfileSection>
        ))}
    </div>
  );
};
