import {
  ProfileSection,
  ProfileSectionPreview,
  useProfileSectionStyles,
} from '~/components/Profile/ProfileSection';
import { useInView } from 'react-intersection-observer';
import { IconApiApp, IconPhoto, IconTrendingUp } from '@tabler/icons-react';
import React, { useMemo } from 'react';
import { useModelQueryParams, useQueryModels } from '~/components/Model/model.utils';
import { ImageSort, ModelSort } from '~/server/common/enums';
import { ModelCard } from '~/components/Cards/ModelCard';
import { Button, Group } from '@mantine/core';
import { NextLink } from '@mantine/next';
import { MetricTimeframe } from '@prisma/client';
import { PeriodFilter, SortFilter } from '~/components/Filters';
import { ModelFiltersDropdown } from '~/components/Model/Infinite/ModelFiltersDropdown';
import { CategoryTags } from '~/components/CategoryTags/CategoryTags';
import { useImageQueryParams, useQueryImages } from '~/components/Image/image.utils';
import { ImageCategories } from '~/components/Image/Filters/ImageCategories';
import { ImageCard } from '~/components/Cards/ImageCard';

const MAX_IMAGES_DISPLAY = 8;
export const MyImagesSection = ({ user }: { user: { id: number; username: string } }) => {
  const { ref, inView } = useInView();
  const { replace, query } = useImageQueryParams();
  const period = query.period ?? MetricTimeframe.AllTime;
  const sort = query.sort ?? ModelSort.Newest;
  const { images: _images, isLoading } = useQueryImages(
    {
      ...query,
      limit: MAX_IMAGES_DISPLAY + 1,
      username: user.username,
      withMeta: false,
      types: undefined,
    },
    { keepPreviousData: true, enabled: inView }
  );

  const images = useMemo(() => _images.slice(0, MAX_IMAGES_DISPLAY), [_images]);

  const { classes } = useProfileSectionStyles({
    count: images.length,
    rowCount: 2,
  });

  if (inView && !isLoading && !images.length) {
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
              value={sort}
              onChange={(x) => replace({ sort: x as ImageSort })}
            />
            <PeriodFilter type="images" value={period} onChange={(x) => replace({ period: x })} />
          </Group>
          <ImageCategories />
          <div className={classes.grid}>
            {images.map((image) => (
              <ImageCard data={image} key={image.id} />
            ))}
          </div>
          {_images.length > MAX_IMAGES_DISPLAY && (
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
