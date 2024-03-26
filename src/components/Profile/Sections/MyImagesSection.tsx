import {
  ProfileSection,
  ProfileSectionNoResults,
  ProfileSectionPreview,
  ProfileSectionProps,
  useProfileSectionStyles,
} from '~/components/Profile/ProfileSection';
import { useInView } from '~/hooks/useInView';
import { IconArrowRight, IconPhoto } from '@tabler/icons-react';
import React, { useMemo } from 'react';
import { ImageSort } from '~/server/common/enums';
import { Anchor, Button, Group, Loader, Text } from '@mantine/core';
import { MetricTimeframe } from '@prisma/client';
import { useDumbImageFilters, useQueryImages } from '~/components/Image/image.utils';
import { ImageCard } from '~/components/Cards/ImageCard';
import Link from 'next/link';
import { ImagesProvider } from '~/components/Image/Providers/ImagesProvider';
import { ShowcaseGrid } from '~/components/Profile/Sections/ShowcaseGrid';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';

const MAX_IMAGES_DISPLAY = 32; // 2 rows of 7

export const MyImagesSection = ({ user }: ProfileSectionProps) => {
  const { ref, inView } = useInView({
    delay: 100,
    triggerOnce: true,
  });
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
      username: user.username,
      withMeta: false,
      types: undefined,
      include: ['profilePictures'],
      browsingLevel,
    },
    { keepPreviousData: true, enabled: inView }
  );

  const images = useMemo(() => _images.slice(0, MAX_IMAGES_DISPLAY), [_images]);

  const { classes, cx } = useProfileSectionStyles({
    count: images.length,
    rowCount: 2,
    widthGrid: '280px',
  });

  const isNullState = !isLoading && !images.length;

  if (isNullState && inView) {
    return null;
  }

  return (
    <div ref={ref} className={isNullState ? undefined : classes.profileSection}>
      {isLoading || !inView ? (
        <ProfileSectionPreview rowCount={2} />
      ) : (
        <ProfileSection
          title="Images"
          icon={<IconPhoto />}
          action={
            !isRefetching && (
              <Link href={`/user/${user.username}/images?sort=${ImageSort.Newest}`} passHref>
                <Button
                  h={34}
                  component="a"
                  variant="subtle"
                  rightIcon={<IconArrowRight size={16} />}
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
            className={cx({
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
      )}
    </div>
  );
};
