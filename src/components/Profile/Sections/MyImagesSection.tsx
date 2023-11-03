import {
  ProfileSection,
  ProfileSectionNoResults,
  ProfileSectionPreview,
  ProfileSectionProps,
  useProfileSectionStyles,
} from '~/components/Profile/ProfileSection';
import { useInView } from 'react-intersection-observer';
import { IconPhoto } from '@tabler/icons-react';
import React, { useMemo } from 'react';
import { ImageSort, ModelSort } from '~/server/common/enums';
import { Button, Group, Loader } from '@mantine/core';
import { NextLink } from '@mantine/next';
import { MetricTimeframe } from '@prisma/client';
import { PeriodFilter, SortFilter } from '~/components/Filters';
import { useDumbImageFilters, useQueryImages } from '~/components/Image/image.utils';
import { DumbImageCategories } from '~/components/Image/Filters/ImageCategories';
import { ImageCard } from '~/components/Cards/ImageCard';
import { ModelCard } from '~/components/Cards/ModelCard';

const MAX_IMAGES_DISPLAY = 8;
export const MyImagesSection = ({ user }: ProfileSectionProps) => {
  const { ref, inView } = useInView();
  const { filters, setFilters, filtersUpdated } = useDumbImageFilters({
    sort: ImageSort.Newest,
    period: MetricTimeframe.AllTime,
    tags: [],
  });

  const { sort, period, tags } = filters;

  const {
    images: _images,
    isLoading,
    isRefetching,
  } = useQueryImages(
    {
      ...filters,
      limit: MAX_IMAGES_DISPLAY + 1,
      username: user.username,
      withMeta: false,
      types: undefined,
    },
    { keepPreviousData: true, enabled: inView }
  );

  const images = useMemo(() => _images.slice(0, MAX_IMAGES_DISPLAY), [_images]);

  const { classes, cx } = useProfileSectionStyles({
    count: images.length,
    rowCount: 2,
  });

  if (inView && !isLoading && !images.length && !filtersUpdated) {
    // No point in showing this without images
    return null;
  }

  return (
    <div ref={ref}>
      {isLoading ? (
        <ProfileSectionPreview />
      ) : (
        <ProfileSection title="Images" icon={<IconPhoto />}>
          <Group position="apart" spacing={0}>
            <SortFilter
              type="images"
              value={sort ?? ImageSort.Newest}
              onChange={(x) => setFilters((f) => ({ ...f, sort: x as ImageSort }))}
            />
            <PeriodFilter
              type="images"
              value={period ?? MetricTimeframe.AllTime}
              onChange={(x) => setFilters((f) => ({ ...f, period: x }))}
            />
          </Group>
          <DumbImageCategories
            value={tags ?? []}
            onChange={(x) => setFilters((f) => ({ ...f, tags: x }))}
          />
          <div
            className={cx({
              [classes.grid]: images.length > 0,
              [classes.nullState]: !images.length,
              [classes.loading]: isRefetching,
            })}
          >
            {!images.length && <ProfileSectionNoResults />}
            {images.map((image) => (
              <ImageCard data={image} key={image.id} />
            ))}
            {isRefetching && <Loader className={classes.loader} />}
          </div>
          {_images.length > MAX_IMAGES_DISPLAY && !isRefetching && (
            <Button
              href={`/user/${user.username}/profile/images`}
              component={NextLink}
              rel="nofollow"
              size="md"
              display="inline-block"
              mr="auto"
            >
              View all images
            </Button>
          )}
        </ProfileSection>
      )}
    </div>
  );
};
