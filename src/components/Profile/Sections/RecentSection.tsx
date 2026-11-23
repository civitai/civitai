import { Button, Text } from '@mantine/core';
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
import type { ProfileSectionProps } from '~/components/Profile/ProfileSection';
import { ProfileSection, ProfileSectionPreview } from '~/components/Profile/ProfileSection';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
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
            <div className="flex flex-wrap gap-4">
              {image && (
                <div className="flex min-w-0 flex-[2_1_300px] flex-col gap-2">
                  <ImagesProvider images={[image]}>
                    <ImageCard data={image} hideCreator aspectRatio={RECENT_TILE_RATIO} />
                  </ImagesProvider>
                  {isOwner && <OwnerImageActions image={image} />}
                </div>
              )}
              {article && (
                <div className="flex min-w-0 flex-[1_1_230px] flex-col gap-2">
                  <Text size="xs" fw={700} tt="uppercase" c="dimmed" className="tracking-wider">
                    Latest article
                  </Text>
                  <ArticleCard data={article} aspectRatio="landscape" />
                  <Button
                    component={NextLink}
                    href={`/user/${user.username}/articles?sort=${ArticleSort.Newest}`}
                    variant="subtle"
                    size="compact-sm"
                    rightSection={<IconArrowRight size={14} />}
                    className="self-start"
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
  const currentUser = useCurrentUser();
  const utils = trpc.useUtils();
  const setBackground = trpc.userProfile.setBackground.useMutation({
    onSuccess: async () => {
      await utils.userProfile.customization.invalidate();
      showSuccessNotification({ message: 'Set as your page background' });
    },
    onError: (error) =>
      showErrorNotification({
        title: 'Could not set your background',
        error: new Error(error.message),
      }),
  });

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
      {currentUser?.isPaidMember && (
        <Button
          variant="default"
          size="compact-sm"
          leftSection={<IconWallpaper size={14} />}
          onClick={() => setBackground.mutate({ imageId: image.id })}
          loading={setBackground.isPending}
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
