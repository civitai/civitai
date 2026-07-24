import {
  Anchor,
  AspectRatio,
  Badge,
  Button,
  Center,
  Container,
  Divider,
  Group,
  LoadingOverlay,
  Stack,
  Text,
  Title,
  Tooltip,
  useComputedColorScheme,
  useMantineTheme,
} from '@mantine/core';
import { IconAlertCircle, IconBolt, IconBookmark, IconShare3 } from '@tabler/icons-react';
import dayjs from '~/shared/utils/dayjs';
import { truncate } from 'lodash-es';
import type { InferGetServerSidePropsType } from 'next';
import React, { useMemo } from 'react';
import { useRouter } from 'next/router';
import * as z from 'zod';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import { ArticleContextMenu } from '~/components/Article/ArticleContextMenu';
import { ArticleDetailComments } from '~/components/Article/Detail/ArticleDetailComments';
import { ArticleScanStatus } from '~/components/Article/ArticleScanStatus';
import { Sidebar } from '~/components/Article/Detail/Sidebar';
import { ToggleArticleEngagement } from '~/components/Article/ToggleArticleEngagement';
import {
  InteractiveTipBuzzButton,
  useBuzzTippingStore,
} from '~/components/Buzz/InteractiveTipBuzzButton';
import { Collection } from '~/components/Collection/Collection';
import { ContainerGrid2 } from '~/components/ContainerGrid/ContainerGrid';
import { useContainerSmallerThan } from '~/components/ContainerProvider/useContainerSmallerThan';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { env } from '~/env/client';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { openArticleRatingReviewModal } from '~/components/Dialog/triggers/article-rating-review';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { ImageContextMenu } from '~/components/Image/ContextMenu/ImageContextMenu';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogLink';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { Gated } from '~/components/Gated/Gated';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { Reactions } from '~/components/Reaction/Reactions';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import { TrackView } from '~/components/TrackView/TrackView';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useHiddenPreferencesData } from '~/hooks/hidden-preferences';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { constants } from '~/server/common/constants';
import { unpublishReasons, type UnpublishReason } from '~/server/common/moderation-helpers';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getBrowsingLevelLabel } from '~/shared/constants/browsingLevel.constants';
import {
  ArticleEngagementType,
  ArticleIngestionStatus,
  ArticleStatus,
  Availability,
} from '~/shared/utils/prisma/enums';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { abbreviateNumber } from '~/utils/number-helpers';
import { removeEmpty } from '~/utils/object-helpers';
import { buildPassthroughQuery, parseNumericString } from '~/utils/query-string-helpers';
import { removeTags, slugit } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';
import classes from './[[...slug]].module.scss';
import { RenderRichText } from '~/components/RichTextEditor/RenderRichText';
import { useInView } from 'react-intersection-observer';

const querySchema = z.object({
  id: z.preprocess(parseNumericString, z.number()),
  slug: z.array(z.string()).optional(),
});

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  resolver: async ({ ctx, ssg }) => {
    const result = querySchema.safeParse(ctx.query);
    if (!result.success) return { notFound: true };

    // Redirect old ?imageId= URLs to the clean article URL
    if (ctx.query.imageId) {
      const slug = result.data.slug?.join('/');
      const destination = `/articles/${result.data.id}${slug ? `/${slug}` : ''}`;
      return {
        redirect: { destination, permanent: true },
      };
    }

    if (ssg) {
      // Fetch article to check slug and prefetch for client hydration
      const article = await ssg.article.getById.fetch({ id: result.data.id }).catch(() => null);

      // Redirect to canonical slug URL if slug is missing or incorrect
      if (article) {
        const correctSlug = slugit(article.title);
        const currentSlug = result.data.slug?.join('/');
        // Skip the redirect when the canonical slug is empty — slugit() strips
        // all non-Latin-alphanumeric chars (strict mode), so CJK/Cyrillic/emoji/
        // dots-only titles slugify to ''. Redirecting to /articles/<id>/ (empty
        // slug) gets trailing-slash-normalized back to /articles/<id>, which
        // never matches '' and loops forever (ERR_TOO_MANY_REDIRECTS). The bare
        // /articles/<id> form just becomes canonical instead.
        if (correctSlug && currentSlug !== correctSlug) {
          const queryString = buildPassthroughQuery(ctx.query);
          // 308 only for bare-id → slug canonical mapping with no query string,
          // because some browsers cache 308 keyed on path only and drop the
          // query on subsequent hits (which strands deep-link params from
          // /comments/v2/<id> and notification redirects). 307 anywhere a
          // query is involved or the slug differs — those redirects are
          // request-specific and should not be cached.
          const permanent = !currentSlug && !queryString;
          return {
            redirect: {
              destination: `/articles/${result.data.id}/${correctSlug}${queryString}`,
              permanent,
            },
          };
        }
      }

      await ssg.hiddenPreferences.getHidden.prefetch();
    }

    return { props: removeEmpty(result.data) };
  },
});

const MAX_WIDTH = 1320;

function ArticleDetailsPage({ id }: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  const currentUser = useCurrentUser();
  const mobile = useContainerSmallerThan('sm');
  const features = useFeatureFlags();

  const { data: article, isLoading, isRefetching } = trpc.article.getById.useQuery({ id });
  const tippedAmount = useBuzzTippingStore({ entityType: 'Article', entityId: id });

  // Intersection observer for lazy loading comments
  const { ref: commentsRef, inView: commentsInView } = useInView({
    triggerOnce: true,
    rootMargin: '100px', // Start loading when 100px away from viewport (reduced from 400px; this delays loading and may worsen perceived performance)
    threshold: 0.1, // Trigger when 10% of the element is visible
  });

  // Force eager mount when the URL targets the comments section, so deep links
  // (#comments, ?highlight=, mod report redirects) load comments on first paint
  // instead of waiting for the user to scroll into the IntersectionObserver.
  // Derived per-render so it stays in sync with router state across navigations
  // (the page component instance is reused by _app without a key).
  const router = useRouter();
  const forceEagerComments =
    !!router.query.highlight ||
    (typeof window !== 'undefined' && window.location.hash === '#comments');

  const { blockedUsers } = useHiddenPreferencesData();
  const isBlocked = blockedUsers.find((u) => u.id === article?.user.id);
  const isModerator = currentUser?.isModerator ?? false;
  const isActualOwner = currentUser?.id === article?.user?.id;
  const isOwner = isActualOwner || isModerator;

  // boolean value that allows us to disable articles via feature flags and still allow us to show articles created by moderators
  const disableArticles = !features.articles && !article?.user.isModerator;

  const queryUtils = trpc.useUtils();
  const upsertArticleMutation = trpc.article.upsert.useMutation();

  const { data: myReview } = trpc.article.getMyArticleRatingReview.useQuery(
    { articleId: id },
    { enabled: isActualOwner && features.articleRatingDispute, staleTime: 60_000 }
  );
  const handlePublishArticle = () => {
    if (!article || article.status === ArticleStatus.Published) return;

    upsertArticleMutation.mutate(
      { ...article, status: ArticleStatus.Published },
      {
        async onSuccess() {
          await queryUtils.article.getById.invalidate({ id });
        },
        onError(error) {
          showErrorNotification({
            title: 'Failed to publish article',
            error: new Error(error.message),
          });
        },
      }
    );
  };

  const memoizedImageData = useMemo(
    () => [article?.coverImage].filter(isDefined),
    [article?.coverImage]
  );
  const { items } = useApplyHiddenPreferences({
    type: 'images',
    data: memoizedImageData,
  });
  const [image] = items;

  if (isLoading) return <PageLoader />;
  if (!article || isBlocked || disableArticles) return <NotFound />;

  const category = article.tags.find((tag) => tag.isCategory);
  const tags = article.tags.filter((tag) => !tag.isCategory);

  const actionButtons = (
    <Group gap={4} align="center" wrap="nowrap">
      <InteractiveTipBuzzButton toUserId={article.user.id} entityType="Article" entityId={id}>
        <IconBadge
          radius="sm"
          style={{ cursor: 'pointer' }}
          color="gray"
          size="lg"
          h={28}
          icon={<IconBolt />}
        >
          <Text className={classes.badgeText}>
            {abbreviateNumber((article.stats?.tippedAmountCountAllTime ?? 0) + tippedAmount)}
          </Text>
        </IconBadge>
      </InteractiveTipBuzzButton>
      <LoginRedirect reason="favorite-article">
        <ToggleArticleEngagement articleId={article.id}>
          {({ toggle, isToggled }) => {
            const isFavorite = isToggled?.Favorite;
            return (
              <IconBadge
                radius="sm"
                color="gray"
                size="lg"
                h={28}
                icon={
                  <IconBookmark
                    color={isFavorite ? theme.colors.gray[2] : undefined}
                    style={{ fill: isFavorite ? theme.colors.gray[2] : undefined }}
                  />
                }
                style={{ cursor: 'pointer' }}
                onClick={() => toggle(ArticleEngagementType.Favorite)}
              >
                <Text className={classes.badgeText}>
                  {abbreviateNumber(article.stats?.collectedCountAllTime ?? 0)}
                </Text>
              </IconBadge>
            );
          }}
        </ToggleArticleEngagement>
      </LoginRedirect>
      <ShareButton url={`/articles/${article.id}/${slugit(article.title)}`} title={article.title}>
        <LegacyActionIcon variant="subtle" color="gray">
          <IconShare3 />
        </LegacyActionIcon>
      </ShareButton>
    </Group>
  );

  const articleBodyText = removeTags(article.content);
  const articleSchema = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: article.title,
    description: truncate(articleBodyText, { length: 200 }),
    // articleBody intentionally omitted — Google reads the page body
    // directly for ranking. Embedding the full text in JSON-LD bloats
    // <head> on long articles without adding meaningful SEO signal.
    image: article.coverImage?.url
      ? getEdgeUrl(article.coverImage.url, { width: 1200 })
      : undefined,
    author:
      article.user.username && !article.user.deletedAt
        ? {
            '@type': 'Person',
            name: article.user.username,
            url: env.NEXT_PUBLIC_BASE_URL
              ? `${env.NEXT_PUBLIC_BASE_URL}/user/${article.user.username}`
              : undefined,
          }
        : undefined,
    datePublished: article.publishedAt,
    dateModified: article.updatedAt,
    publisher: {
      '@type': 'Organization',
      name: 'Civitai',
      url: env.NEXT_PUBLIC_BASE_URL,
    },
    keywords: article.tags?.map((t) => t.name).join(', ') || undefined,
    mainEntityOfPage: env.NEXT_PUBLIC_BASE_URL
      ? {
          '@type': 'WebPage',
          '@id': `${env.NEXT_PUBLIC_BASE_URL}/articles/${article.id}/${slugit(article.title)}`,
        }
      : undefined,
  };

  return (
    <Gated
      contentNsfwLevel={article.nsfwLevel}
      bypassRating={isOwner}
      meta={{
        title: `${article.title} | Civitai`,
        description: truncate(articleBodyText, { length: 150 }),
        images: article?.coverImage,
        ogEndpoint: `/api/og?type=article&id=${article.id}`,
        canonical: `/articles/${article.id}/${slugit(article.title)}`,
        alternate: `/articles/${article.id}`,
        schema: articleSchema,
        deIndex: !article?.publishedAt || article?.availability === Availability.Unsearchable,
      }}
    >
      <TrackView entityId={article.id} entityType="Article" type="ArticleView" />
      <Container size="xl" pos="relative">
        <LoadingOverlay visible={isRefetching || upsertArticleMutation.isPending} />
        <Stack gap={8} mb="xl">
          <Group justify="space-between" wrap="nowrap">
            <Title fw="bold" className={classes.title} order={1}>
              {article.title}
            </Title>
            <Group align="center" className={classes.titleWrapper} wrap="nowrap">
              {!mobile && actionButtons}
              <ArticleContextMenu article={article} />
            </Group>
          </Group>
          <Group gap={8}>
            <UserAvatar user={article.user} withUsername linkToProfile />
            <Divider orientation="vertical" />
            <Text c="dimmed" size="sm">
              {article.publishedAt ? formatDate(article.publishedAt) : 'Draft'}
            </Text>
            {article.publishedAt &&
              article.updatedAt &&
              dayjs(article.updatedAt) > dayjs(article.publishedAt).add(1, 'hour') && (
                <Tooltip label={formatDate(article.updatedAt, 'MMM D, YYYY hh:mm:ss A')}>
                  <Text size="sm" c="dimmed" className="cursor-default">
                    (Updated: {dayjs().to(dayjs(article.updatedAt))})
                  </Text>
                </Tooltip>
              )}
            {category && (
              <>
                <Divider orientation="vertical" />
                <Link legacyBehavior href={`/articles?view=feed&tags=${category.id}`} passHref>
                  <Badge
                    component="a"
                    size="sm"
                    variant="gradient"
                    gradient={{ from: 'cyan', to: 'blue' }}
                    style={{ cursor: 'pointer' }}
                  >
                    {category.name}
                  </Badge>
                </Link>
              </>
            )}
            {!!tags.length && (
              <>
                <Divider orientation="vertical" />
                <Collection
                  items={tags}
                  renderItem={(tag) => (
                    <Link
                      legacyBehavior
                      key={tag.id}
                      href={`/articles?view=feed&tags=${tag.id}`}
                      passHref
                    >
                      <Badge
                        component="a"
                        color="gray"
                        variant={colorScheme === 'dark' ? 'filled' : undefined}
                        style={{ cursor: 'pointer' }}
                      >
                        {tag.name}
                      </Badge>
                    </Link>
                  )}
                  grouped
                />
              </>
            )}
          </Group>
          {article.status === ArticleStatus.Unpublished && isOwner && (
            <AlertWithIcon size="lg" icon={<IconAlertCircle />} color="yellow" iconColor="yellow">
              <div>
                This article has been unpublished.{' '}
                <Anchor component="button" className="inline-flex" onClick={handlePublishArticle}>
                  Click here
                </Anchor>{' '}
                to publish it again or make changes to it before publishing.
              </div>
            </AlertWithIcon>
          )}
          {article.status === ArticleStatus.UnpublishedViolation && (
            <AlertWithIcon size="lg" icon={<IconAlertCircle />} color="red" iconColor="red">
              <div>
                <Text weight={600} size="lg" mb="xs">
                  This article has been unpublished due to a Terms of Service violation
                </Text>
                {article.metadata?.unpublishedReason &&
                  article.metadata.unpublishedReason !== 'other' && (
                    <Text>
                      <strong>Reason:</strong>{' '}
                      {
                        unpublishReasons[article.metadata.unpublishedReason as UnpublishReason]
                          ?.notificationMessage
                      }
                    </Text>
                  )}
                {article.metadata?.customMessage && (
                  <Text>
                    <strong>Additional details:</strong> {article.metadata.customMessage}
                  </Text>
                )}
                {!isModerator && (
                  <Text mt="sm" size="sm">
                    If you believe this was done in error, please contact support.
                  </Text>
                )}
              </div>
            </AlertWithIcon>
          )}
          {isOwner &&
            (article.ingestion === ArticleIngestionStatus.Error ||
              article.ingestion === ArticleIngestionStatus.Blocked) && (
              <AlertWithIcon size="lg" icon={<IconAlertCircle />} color="red" iconColor="red">
                <div>
                  <Text fw={600} size="lg" mb="xs">
                    This article isn&apos;t visible to the public
                  </Text>
                  <Text size="sm">
                    {article.ingestion === ArticleIngestionStatus.Blocked
                      ? 'One or more images were blocked by our content policy, so the article stays hidden from the public until the issue is resolved.'
                      : 'Image scanning failed for one or more images (ingestion error), so the article stays hidden from the public until the scan succeeds or a moderator resolves it.'}
                  </Text>
                </div>
              </AlertWithIcon>
            )}
          {isOwner && article.ingestion && article.ingestion !== ArticleIngestionStatus.Scanned && (
            <ArticleScanStatus
              articleId={article.id}
              onComplete={() => queryUtils.article.getById.invalidate({ id: article.id })}
            />
          )}
          {isActualOwner && features.articleRatingDispute && (
            <ArticleOwnerRatingControls
              articleId={article.id}
              nsfwLevel={article.nsfwLevel}
              myReview={myReview?.review ?? null}
              canResubmit={myReview?.canResubmit ?? true}
              derivedLevel={myReview?.derivedLevel ?? null}
              derivedRatingDroppedBelowOverride={
                myReview?.derivedRatingDroppedBelowOverride ?? false
              }
            />
          )}
        </Stack>
        <ContainerGrid2 gutter="xl">
          <ContainerGrid2.Col span={{ base: 12, sm: 8 }}>
            <Stack gap="xs">
              {image && (
                <AspectRatio
                  ratio={constants.article.coverImageWidth / constants.article.coverImageHeight}
                >
                  <RoutedDialogLink
                    name="imageDetail"
                    state={{ imageId: image.id, withoutPost: true }}
                    className="block size-full cursor-pointer"
                  >
                    <Center className="size-full">
                      <div className="relative size-full">
                        <ImageGuard2 image={image} connectType="article" connectId={article.id}>
                          {(safe) => (
                            <>
                              <ImageGuard2.BlurToggle className="absolute left-2 top-2 z-10" />
                              <ImageContextMenu
                                image={image}
                                noDelete={true}
                                className="absolute right-2 top-2 z-10"
                              />
                              {!safe ? (
                                <div className="relative h-full overflow-hidden rounded-lg object-cover">
                                  <MediaHash {...image} />
                                </div>
                              ) : (
                                <EdgeMedia
                                  src={image.url}
                                  className="h-full rounded-lg object-cover"
                                  name={image.name}
                                  alt={article.title}
                                  type={image.type}
                                  width={MAX_WIDTH}
                                  anim={safe}
                                />
                              )}
                            </>
                          )}
                        </ImageGuard2>
                      </div>
                    </Center>
                  </RoutedDialogLink>
                </AspectRatio>
              )}

              {article.contentJson && (
                <article>
                  <RenderRichText content={article.contentJson} />
                </article>
              )}
              <Divider />
              <Group justify="space-between">
                <Reactions
                  entityType="article"
                  reactions={article.reactions}
                  entityId={article.id}
                  metrics={{
                    likeCount: article.stats?.likeCountAllTime,
                    dislikeCount: article.stats?.dislikeCountAllTime,
                    heartCount: article.stats?.heartCountAllTime,
                    laughCount: article.stats?.laughCountAllTime,
                    cryCount: article.stats?.cryCountAllTime,
                  }}
                  targetUserId={article.user.id}
                />
                {actionButtons}
              </Group>
            </Stack>
          </ContainerGrid2.Col>
          <ContainerGrid2.Col span={{ base: 12, sm: 4 }}>
            <Sidebar
              creator={article.user}
              attachments={article.attachments}
              articleId={article.id}
            />
          </ContainerGrid2.Col>
        </ContainerGrid2>
        <div id="comments" ref={commentsRef}>
          {(commentsInView || forceEagerComments) && (
            <ArticleDetailComments articleId={article.id} userId={article.user.id} />
          )}
        </div>
      </Container>
    </Gated>
  );
}

export default Page(ArticleDetailsPage);

type OwnerRatingReview = {
  id: number;
  status: 'Pending' | 'Actioned' | 'Unactioned' | string;
  createdAt: Date | string;
  resolvedAt: Date | string | null;
  appliedLevel: number | null;
  modComment?: string | null;
};

function ArticleOwnerRatingControls({
  articleId,
  nsfwLevel,
  myReview,
  canResubmit: canResubmitFromServer,
  derivedLevel,
  derivedRatingDroppedBelowOverride,
}: {
  articleId: number;
  nsfwLevel: number;
  myReview: OwnerRatingReview | null | undefined;
  canResubmit: boolean;
  derivedLevel: number | null;
  derivedRatingDroppedBelowOverride: boolean;
}) {
  const ratingLabel = getBrowsingLevelLabel(nsfwLevel);

  // A review is "pending" if it exists and has not been resolved.
  const isPending = !!myReview && myReview.status === 'Pending';
  const isResolved = !!myReview && myReview.status !== 'Pending';

  // After resolution, the owner may submit again only after the article has
  // been edited (server-side check mirrors this — see plan §11). The server
  // returns `canResubmit` directly so the client doesn't have to redo the
  // date math; trust it.
  const canResubmit = !myReview || (isResolved && canResubmitFromServer);

  // Owner-visible signal for a stale moderator override: the article has been
  // edited (canResubmit is true) AND the system-derived rating has dropped
  // below the override. Server gates this on having an active override + a
  // resolvable derived level, so we only need to combine it with `canResubmit`
  // here. We additionally require derivedLevel >= 1 — a text-only article can
  // yield derivedLevel = 0 (no images, no floor), which has no canonical
  // browsing-level label and would render as "?" in the banner copy and
  // pre-fill the dispute modal with an invalid level. Owner can still open
  // the dispute modal via the inline button in that case.
  const showStaleOverrideBanner =
    derivedRatingDroppedBelowOverride &&
    canResubmit &&
    derivedLevel != null &&
    derivedLevel >= 1;

  const handleOpen = (initialSuggestedLevel?: number) => {
    openArticleRatingReviewModal({ articleId, currentLevel: nsfwLevel, initialSuggestedLevel });
  };

  // Button label + state matrix:
  //   no review  → "Request rating review" (enabled)
  //   pending    → "Review pending" (disabled, with timestamp helper)
  //   resolved, no edits since → "Last review <status> on <date>" (disabled, modComment tooltip)
  //   resolved, edits since    → "Request rating review" (enabled — fresh dispute)
  let button: React.ReactNode;
  if (isPending) {
    button = (
      <Tooltip
        label={
          <span>
            Submitted <DaysFromNow date={new Date(myReview!.createdAt)} />
          </span>
        }
        withArrow
      >
        <Button variant="default" size="xs" disabled>
          Review pending
        </Button>
      </Tooltip>
    );
  } else if (isResolved && !canResubmit) {
    const resolvedDate = myReview!.resolvedAt
      ? formatDate(new Date(myReview!.resolvedAt))
      : '';
    const statusLabel =
      myReview!.status === 'Actioned'
        ? 'approved'
        : myReview!.status === 'Unactioned'
        ? 'declined'
        : myReview!.status.toLowerCase();
    const btn = (
      <Button variant="default" size="xs" disabled>
        Last review {statusLabel}
        {resolvedDate ? ` on ${resolvedDate}` : ''}
      </Button>
    );
    button = myReview!.modComment ? (
      <Tooltip label={myReview!.modComment} withArrow multiline w={260}>
        {btn}
      </Tooltip>
    ) : (
      btn
    );
  } else {
    button = (
      <Button variant="default" size="xs" onClick={() => handleOpen()}>
        Request rating review
      </Button>
    );
  }

  return (
    <Stack gap="xs">
      {showStaleOverrideBanner && (
        <AlertWithIcon icon={<IconAlertCircle size={20} />} color="yellow" iconColor="yellow">
          <Stack gap="xs">
            <Text size="sm">
              Your recent edits brought this article&apos;s content down to{' '}
              <Text component="span" fw={600}>
                {getBrowsingLevelLabel(derivedLevel!)}
              </Text>
              , but a previous moderator decision pinned the rating at{' '}
              <Text component="span" fw={600}>
                {ratingLabel}
              </Text>
              . Request a rating review and our system (or a moderator) will update it.
            </Text>
            <Group>
              <Button
                size="xs"
                color="yellow"
                variant="filled"
                onClick={() => handleOpen(derivedLevel!)}
              >
                Request rating review
              </Button>
            </Group>
          </Stack>
        </AlertWithIcon>
      )}
      <Group gap="xs" align="center">
        <Text size="sm" c="dimmed">
          Rating:
        </Text>
        <Badge size="md" variant="filled" color="gray">
          {ratingLabel}
        </Badge>
        {/* Hide the redundant inline CTA when the banner is rendering its own. */}
        {showStaleOverrideBanner ? null : button}
      </Group>
    </Stack>
  );
}
