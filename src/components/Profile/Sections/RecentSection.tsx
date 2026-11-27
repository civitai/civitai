import { Button } from '@mantine/core';
import {
  IconArrowRight,
  IconClock,
  IconHeart,
  IconPhoto,
  IconWallpaper,
} from '@tabler/icons-react';
import React from 'react';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { ArticleCard } from '~/components/Cards/ArticleCard';
import { ImageCard } from '~/components/Cards/ImageCard';
import { useQueryArticles } from '~/components/Article/article.utils';
import { useQueryImages } from '~/components/Image/image.utils';
import { ImagesProvider } from '~/components/Image/Providers/ImagesProvider';
import { useInViewDynamic } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import { NextLink } from '~/components/NextLink/NextLink';
import { useAddToShowcaseAction } from '~/components/Profile/AddToShowcaseMenuItem';
import { useSetProfileBackground } from '~/components/Profile/SetAsBackground';
import type { ProfileSectionProps } from '~/components/Profile/ProfileSection';
import { ProfileSection, ProfileSectionPreview } from '~/components/Profile/ProfileSection';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ArticleSort, ImageSort } from '~/server/common/enums';
import type { ImagesInfiniteModel } from '~/server/services/image.service';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import classes from '~/components/Profile/ProfileSection.module.css';

const RECENT_TILE_RATIO = 2.2;

export const RecentSection = ({ user }: ProfileSectionProps) => {
  const [ref, inView] = useInViewDynamic({ id: 'profile-recent-section' });
  const currentUser = useCurrentUser();
  const isOwner = currentUser?.id === user.id;
  const browsingLevel = useBrowsingLevelDebounced();

  const { images, isLoading: imagesLoading } = useQueryImages(
    {
      sort: ImageSort.Newest,
      period: MetricTimeframe.AllTime,
      limit: 1,
      userId: user.id,
      withMeta: false,
      include: ['profilePictures', 'cosmetics'],
      browsingLevel,
      notPublished: false,
    },
    { keepPreviousData: true, enabled: inView }
  );
  const { articles, isLoading: articlesLoading } = useQueryArticles(
    { limit: 1, username: user.username, sort: ArticleSort.Newest },
    { keepPreviousData: true, enabled: inView }
  );

  const image = images[0];
  const article = articles[0];
  const isLoading = imagesLoading || articlesLoading;
  const isNullState = !isLoading && !image && !article;

  if (isNullState && inView) return null;

  return (
    <div ref={ref} className={isNullState ? undefined : classes.profileSection}>
      {inView &&
        (isLoading ? (
          <ProfileSectionPreview columnCount={3} />
        ) : (
          <ProfileSection title="Most recent" icon={<IconClock />}>
            {/* Image and article share a top and bottom edge; their buttons share the row under them. */}
            <div className="grid grid-cols-1 gap-x-4 gap-y-2 @md:grid-cols-[2fr_1fr]">
              {image && (
                <div className="min-w-0 @md:col-start-1 @md:row-start-1">
                  <ImagesProvider images={[image]}>
                    <ImageCard
                      data={image}
                      hideCreator
                      aspectRatio={RECENT_TILE_RATIO}
                      // The tile spans most of the content column, about twice a feed card.
                      mediaWidth={1080}
                    />
                  </ImagesProvider>
                </div>
              )}
              {image && isOwner && (
                <div className="@md:col-start-1 @md:row-start-2">
                  <OwnerImageActions image={image} />
                </div>
              )}
              {article && (
                <div className="min-w-0 @md:col-start-2 @md:row-start-1">
                  {/* Twice as wide a column beside a 2.2:1 tile: 1.1:1 keeps the two the same height. */}
                  <ArticleCard
                    data={article}
                    aspectRatio={image ? RECENT_TILE_RATIO / 2 : 'landscape'}
                    label="Latest article"
                  />
                </div>
              )}
              {article && (
                <div className="@md:col-start-2 @md:row-start-2">
                  <Button
                    component={NextLink}
                    href={`/user/${user.username}/articles?sort=${ArticleSort.Newest}`}
                    variant="subtle"
                    size="compact-sm"
                    rightSection={<IconArrowRight size={14} />}
                  >
                    All articles
                  </Button>
                </div>
              )}
            </div>
          </ProfileSection>
        ))}
    </div>
  );
};

function OwnerImageActions({ image }: { image: ImagesInfiniteModel }) {
  const { addToShowcase, disabled } = useAddToShowcaseAction({
    entityType: 'Image',
    entityId: image.id,
  });
  const background = useSetProfileBackground();

  return (
    <div className="flex flex-wrap gap-2">
      <Button
        variant="default"
        size="compact-sm"
        leftSection={<IconHeart size={14} />}
        onClick={addToShowcase}
        disabled={disabled}
      >
        Add to Showcase
      </Button>
      {background.available && (
        <Button
          variant="default"
          size="compact-sm"
          leftSection={<IconWallpaper size={14} />}
          onClick={() => background.setBackground(image.id)}
          loading={background.isPending}
        >
          Set as background
        </Button>
      )}
      {image.postId && (
        <Button
          component={NextLink}
          href={`/posts/${image.postId}`}
          variant="default"
          size="compact-sm"
          leftSection={<IconPhoto size={14} />}
        >
          View post
        </Button>
      )}
    </div>
  );
}
