import { PlacementSpaceToggle } from '~/components/Sticker/PlacementSpaceToggle';
import {
  pendingRemixSubmissions,
  useRemixSubmitSelection,
} from '~/components/RemixGallery/remix-submit-selection.store';
import type { TooltipProps } from '@mantine/core';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Stack,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
} from '@mantine/core';
import { IconAlertCircle, IconClock, IconTrash } from '@tabler/icons-react';
import { useIsMutating } from '@tanstack/react-query';
import { useRouter } from 'next/router';
import { useMemo, useRef, useState } from 'react';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import ConfirmDialog from '~/components/Dialog/Common/ConfirmDialog';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { HelpButton } from '~/components/HelpButton/HelpButton';
import { PostingToModel3DCard } from '~/components/Model3D/Posting/PostingToModel3DCard';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { DeletePostButton } from '~/components/Post/DeletePostButton';
import { usePostEditParams, usePostEditStore } from '~/components/Post/EditV2/PostEditProvider';
import { ReorderImagesButton } from '~/components/Post/EditV2/PostReorderImages';
import { SchedulePostModal } from '~/components/Post/EditV2/SchedulePostModal';
import { usePostContestCollectionDetails } from '~/components/Post/post.utils';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import { useCatchNavigation } from '~/hooks/useCatchNavigation';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useTourContext } from '~/components/Tours/ToursProvider';
import type { PostDetailEditable } from '~/server/services/post.service';
import { CollectionType } from '~/shared/utils/prisma/enums';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { removeEmpty } from '~/utils/object-helpers';
import { safeInternalPath } from '~/utils/url-helpers';
import { isValidAIGeneration, hasImageLicenseViolation } from '~/utils/image-utils';
import type { ImageMetaProps } from '~/server/schema/image.schema';
import type { ImageResourceHelper } from '~/shared/utils/prisma/models';

const getLicenseViolationDetails = (
  images: Array<{ nsfwLevel: number; resourceHelper: ImageResourceHelper[] }>
) => {
  const violatingImages = images.filter((image) => {
    return hasImageLicenseViolation(image).violation;
  });

  if (violatingImages.length === 0) return null;

  const count = violatingImages.length;
  const isPlural = count > 1;

  return `${count} image${isPlural ? 's' : ''} violate${
    isPlural ? '' : 's'
  } license restrictions for ${
    isPlural ? 'their' : 'its'
  } NSFW content level. Check the alerts on your images for details.`;
};

export function PostEditSidebar({ post }: { post: PostDetailEditable }) {
  // #region [state]
  const queryUtils = trpc.useUtils();
  const router = useRouter();
  const params = usePostEditParams();
  const currentUser = useCurrentUser();
  const { runTour } = useTourContext();
  const features = useFeatureFlags();

  const [deleted, setDeleted] = useState(false);
  const [
    updatePost,
    isReordering,
    hasImages,
    showReorder,
    collectionId,
    collectionTagId,
    images,
    flushPendingSaves,
  ] = usePostEditStore((state) => [
    state.updatePost,
    state.isReordering,
    state.images.filter((x) => x.type === 'added').length > 0,
    state.images.length > 1,
    state.collectionId,
    state.collectionTagId,
    state.images,
    state.flushPendingSaves,
  ]);
  const todayRef = useRef(new Date());

  const addedImages = useMemo(
    () => images.filter((image) => image.type === 'added').map((image) => image.data),
    [images]
  );

  const isAiVerified = !addedImages.some(
    (image) =>
      !isValidAIGeneration({
        id: image.id,
        nsfwLevel: image.nsfwLevel,
        resources: image.resourceHelper,
        tools: image.tools,
        meta: image.meta as ImageMetaProps,
        tags: image.tags,
      })
  );

  // Check for NSFW license violations
  const hasNsfwLicenseViolations = addedImages.some(
    (image) => hasImageLicenseViolation(image).violation
  );

  const canPublish =
    hasImages && !isReordering && isAiVerified && !hasNsfwLicenseViolations && features.canWrite;

  const canSchedule = post.publishedAt && post.publishedAt.getTime() > new Date().getTime();
  // Post was previously public, then unpublished via the parent
  // model/version flow. publishedAt is NULL while a `prevPublishedAt`
  // stash sits on Post.metadata. Hide Publish + Schedule controls — the
  // post is gated by the parent's status; the user has to republish the
  // parent model/version to bring this post back. Re-publishing the post
  // directly would just restore the stashed date (via the CASE in
  // updatePost) without making the post visible, which is confusing.
  const isUnpublishedByParent = post.wasPublished && !post.publishedAt;
  // Build a link to the parent model edit page so the user can see why the
  // parent was taken down (the unpublish reason lives on the model/version,
  // not on the post). Use `post.parentModelId` from the unpublish-context
  // helper rather than `post.modelVersion?.id` — postSelect filters the
  // modelVersion subquery by `publishedAt IS NOT NULL`, so it's null when
  // the parent is unpublished (exactly the case we care about here).
  const parentModelHref =
    post.parentModelId && post.modelVersionId
      ? `/models/${post.parentModelId}?modelVersionId=${post.modelVersionId}`
      : null;
  const { returnUrl, afterPublish } = params;

  const { collection } = usePostContestCollectionDetails(
    { id: post.id },
    { enabled: !!collectionId }
  );
  // #endregion

  // #region [mutations]
  const updatePostMutation = trpc.post.update.useMutation();
  const submitRemix = trpc.placement.submitToRemixGallery.useMutation();
  const mutating = useIsMutating({
    predicate: (mutation) => mutation.options.mutationKey?.flat().includes('post') ?? false,
    exact: false,
  });
  const publishLabel = collectionId ? 'Submit' : 'Publish';
  // #endregion

  // #region [publish post]
  /**
   * Sends the remix-gallery submissions the poster ticked in the image cards.
   *
   * After the post is published, never before: the mutation requires a published
   * image, and a submission made against a draft would be refused with an error
   * the poster cannot act on.
   *
   * Failures are reported and swallowed rather than thrown. The post IS
   * published by this point — rejecting here would leave the poster looking at
   * an error over work that succeeded, and a failed submission costs them
   * nothing because escrow is only held once the row exists. Each pair is
   * settled independently for the same reason: one closed gallery must not take
   * the others down with it.
   */
  async function submitTickedRemixes() {
    const { selected, clearAll } = useRemixSubmitSelection.getState();
    const pending = pendingRemixSubmissions(selected);
    if (!pending.length) return;

    const results = await Promise.allSettled(
      pending.map(({ imageId, hostImageId, expectedPrice, free }) =>
        submitRemix.mutateAsync({
          imageId,
          hostImageId,
          // Omitted entirely on the free path rather than sent as 0 — the schema
          // requires it only for a paid submission, and a 0 here would be a
          // price agreement the poster never made.
          ...(free ? { free: true } : { expectedPrice: expectedPrice ?? 0 }),
        })
      )
    );

    // Cleared unconditionally: every pair has now had its one attempt, and a
    // selection left armed would resubmit on the next publish of the same post.
    clearAll();

    const failed = results.filter((result) => result.status === 'rejected').length;
    const sent = results.length - failed;

    if (sent > 0)
      showSuccessNotification({
        title: sent === 1 ? 'Remix submitted' : `${sent} remixes submitted`,
        message: 'The creator will see it in their gallery queue.',
      });

    // Named as its own count rather than folded into the success line. A poster
    // told "2 submitted" over 3 ticks has to work out which one is missing.
    if (failed > 0)
      showErrorNotification({
        title: failed === 1 ? "A remix wasn't submitted" : `${failed} remixes weren't submitted`,
        error: new Error('Your post published fine. You can submit from the image page instead.'),
      });
  }

  const publish = (publishedAt = new Date()) =>
    updatePostMutation.mutate(
      {
        id: post.id ?? 0,
        title: !post.title ? params.postTitle : undefined,
        publishedAt,
        collectionId,
        collectionTagId,
      },
      {
        onSuccess: async (_, post) => {
          const { id, publishedAt } = post;
          updatePost((data) => {
            data.publishedAt = publishedAt ?? null;
          });
          if (publishedAt) await submitTickedRemixes();
          if (publishedAt && afterPublish) await afterPublish({ postId: id, publishedAt });
          else {
            if (returnUrl) router.push(safeInternalPath(returnUrl, `/posts/${post.id}`));
            else router.push({ pathname: `/posts/${post.id}`, query: removeEmpty({ returnUrl }) });
          }
          await queryUtils.image.getImagesAsPostsInfinite.invalidate();
        },
        onError: (error) => {
          showErrorNotification({
            title: 'There was an error while trying to publish your post',
            error,
          });
        },
      }
    );

  const imagesInReview = useMemo(
    () => addedImages.filter((image) => !!image.needsReview),
    [addedImages]
  );

  const handleShowConfirmPublish = (date?: Date) => {
    const reviewCount = imagesInReview.length;
    const isPlural = reviewCount > 1;
    const hasReview = reviewCount > 0;
    dialogStore.trigger({
      component: ConfirmDialog,
      props: {
        title: hasReview ? 'Images pending review' : params.confirmTitle,
        message: hasReview ? (
          <>
            <Text>
              {reviewCount} image{isPlural ? 's' : ''} in this post {isPlural ? 'are' : 'is'}{' '}
              currently flagged for moderation review and will remain hidden from other users until
              approved.
            </Text>
            {params.confirmMessage && <Text mt="sm">{params.confirmMessage}</Text>}
            <Text mt="sm">Do you want to publish anyway?</Text>
          </>
        ) : (
          params.confirmMessage ?? 'Are you sure you want to publish this post?'
        ),
        labels: hasReview ? { confirm: 'Publish anyway', cancel: 'Cancel' } : undefined,
        onConfirm: () => publish(date),
      },
    });
  };

  const handlePublish = (date?: Date, confirmPublish = params.confirmPublish) => {
    const needsConfirm = confirmPublish || imagesInReview.length > 0;
    needsConfirm ? handleShowConfirmPublish(date) : publish(date);
  };

  const handleScheduleClick = () => {
    // Defensive: the Schedule controls aren't rendered when
    // `isUnpublishedByParent`, but guard the entry point in case a future
    // call site (keyboard shortcut, programmatic trigger) bypasses the UI.
    if (isUnpublishedByParent) return;
    dialogStore.trigger({
      component: SchedulePostModal,
      props: {
        onSubmit: handlePublish,
        publishedAt: post.publishedAt,
        publishingModel: !!post.modelVersionId,
      },
    });
  };

  // Holds the url this handler pushed, so the guard below waives that navigation and no other.
  // The ref is what the guard reads (synchronously, mid-navigation); the state is only the
  // button's spinner, since the awaited push is a real round trip to the destination.
  const savingDraftRef = useRef<string | null>(null);
  const [savingDraft, setSavingDraft] = useState(false);

  const handleSaveAsDraft = async () => {
    // A second click would push again and let the first push's `finally` re-arm the guard
    // mid-navigation, prompting on a navigation the user explicitly asked for.
    if (savingDraftRef.current) return;

    flushPendingSaves();

    // Only the owner has a drafts section to land on — `/posts/[postId]/edit` also admits
    // moderators, and the profile posts page shows Published for anyone but the owner.
    const isOwner = currentUser?.id === post.user.id;
    // `section=draft` because the posts tab defaults to Published, where the post just saved
    // is by definition absent.
    const fallback =
      isOwner && currentUser.username
        ? `/user/${currentUser.username}/posts?section=draft`
        : `/posts/${post.id}`;
    const destination = safeInternalPath(returnUrl, fallback);

    savingDraftRef.current = destination;
    setSavingDraft(true);
    try {
      await router.push(destination);
    } catch {
      // swallowed: a rejected push is a navigation that didn't happen, and the only
      // thing to do about it is the reset below
    } finally {
      // A push that fails or is cancelled leaves this component mounted, and a bypass that
      // outlives its own navigation disables the unsaved-changes guard for good.
      savingDraftRef.current = null;
      setSavingDraft(false);
    }
  };

  useCatchNavigation({
    // When the post is unpublished because the parent model/version is
    // unpublished, the user can't republish from this page anyway —
    // showing the "you haven't published this post" warning is misleading.
    unsavedChanges: !post.publishedAt && !deleted && !isUnpublishedByParent,
    // Every edit is autosaved and the provider flushes anything still pending on the way out,
    // so nothing is lost here — what the user needs warning about is that a draft is invisible
    // until they publish it, which is the mistake this prompt was added to prevent.
    message: `Your changes are saved, but this post is still a draft — it stays hidden until you publish it. Leave anyway?`,
    bypassRef: savingDraftRef,
  });
  // #endregion

  const postLabel = collectionId ? 'Entry' : 'Post';

  return (
    <>
      <div className="flex flex-col gap-0">
        {collection?.metadata?.includeContestCallouts && (
          <Alert mb="xs">
            <div className="flex">
              <Text size="xs">
                Please add the AI and filmmaking tools you used in your entry. Depending on the
                tool, you&apos;ll automatically be eligible for the{' '}
                <Anchor
                  target="_blank"
                  rel="noopener nofollow"
                  href="https://www.projectodyssey.ai/free-trials-and-prizes"
                >
                  Title and Gold Sponsor Awards
                </Anchor>
                .
              </Text>
            </div>
          </Alert>
        )}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Title size="sm">{postLabel}</Title>
            {features.appTour && (
              <HelpButton
                data-tour="post:reset"
                tooltip="Need help? Start the tour!"
                onClick={() =>
                  runTour({ key: 'post-generation', step: 0, forceRun: true, trigger: 'help' })
                }
              />
            )}
          </div>
          <Badge color={mutating > 0 ? 'yellow' : 'green'} size="lg">
            {mutating > 0 ? 'Saving' : 'Saved'}
          </Badge>
        </div>

        <Text size="xs" component="div">
          {isUnpublishedByParent ? (
            <>Your {postLabel} is currently hidden because its parent resource was unpublished.</>
          ) : !post.publishedAt ? (
            <>
              Your {postLabel} is currently{' '}
              <Tooltip
                label={`Click the ${publishLabel} button to make your post Public to share with the Civitai community for comments and reactions.`}
                {...tooltipProps}
              >
                <Text component="span" td="underline">
                  hidden
                </Text>
              </Tooltip>
            </>
          ) : post.publishedAt > todayRef.current ? (
            <div className="flex items-center gap-1">
              <ThemeIcon color="gray" variant="filled" radius="xl">
                <IconClock size={20} />
              </ThemeIcon>
              <span>Scheduled for {formatDate(post.publishedAt, 'MMMM D, h:mma')}</span>
            </div>
          ) : (
            <>
              Published <DaysFromNow date={post.publishedAt} />
            </>
          )}
        </Text>
      </div>

      {params.model3dId ? <PostingToModel3DCard model3dId={params.model3dId} /> : null}

      {isUnpublishedByParent && (
        <Alert color="yellow" icon={<IconAlertCircle size={16} />} radius="sm" className="shrink-0">
          <Stack gap="xs">
            <Text size="sm" fw={600}>
              Post unpublished
            </Text>
            {post.unpublishedAt && (
              <Text size="xs">
                Unpublished on {formatDate(post.unpublishedAt, 'MMMM D, YYYY')}.
              </Text>
            )}
            <Text size="xs">
              This post is hidden because its parent model or version was unpublished. Republish the
              parent to bring this post back — the original publish date will be preserved.
            </Text>
            {parentModelHref && (
              <Text size="xs">
                <Anchor href={parentModelHref}>View the parent model</Anchor> to see why it was
                unpublished.
              </Text>
            )}
          </Stack>
        </Alert>
      )}

      {isUnpublishedByParent ? null : !post.publishedAt ? (
        <Tooltip
          disabled={canPublish}
          label={
            !isAiVerified
              ? 'We could not verify some of your NSFW images were AI generated. Please add proper metadata before publishing this post.'
              : hasNsfwLicenseViolations
              ? getLicenseViolationDetails(addedImages)
              : isReordering
              ? 'Finish rearranging your images before you publish'
              : 'At least one image is required in order to publish this post to the community'
          }
          multiline
          w="260px"
          withArrow
        >
          {collectionId ? (
            <Button
              disabled={!canPublish || !!mutating}
              onClick={() => handlePublish()}
              loading={updatePostMutation.isPending}
              data-tour="post:publish"
            >
              {publishLabel}
            </Button>
          ) : (
            <Button.Group>
              <Button
                disabled={!canPublish || !!mutating}
                onClick={() => handlePublish()}
                loading={updatePostMutation.isPending}
                className="flex-1"
                data-tour="post:publish"
              >
                {publishLabel}
              </Button>
              <Tooltip label="Schedule Publish" disabled={!hasImages} withArrow>
                <Button
                  variant="outline"
                  loading={updatePostMutation.isPending}
                  onClick={handleScheduleClick}
                  disabled={!canPublish || !!mutating}
                >
                  <IconClock size={20} />
                </Button>
              </Tooltip>
            </Button.Group>
          )}
        </Tooltip>
      ) : (
        <Button.Group>
          <ShareButton
            title={post.title ?? undefined}
            url={`/posts/${post.id}`}
            collect={{ type: CollectionType.Post, postId: post.id }}
          >
            <Button variant="default" className="flex-1">
              Share
            </Button>
          </ShareButton>
          {canSchedule && (
            <Tooltip label="Reschedule Publish" disabled={!hasImages} withArrow>
              <Button
                variant="filled"
                color="gray"
                loading={updatePostMutation.isPending}
                onClick={handleScheduleClick}
                disabled={!canPublish}
              >
                <IconClock size={20} />
              </Button>
            </Tooltip>
          )}
        </Button.Group>
      )}

      {!post.publishedAt && !isUnpublishedByParent && !deleted && (
        <Button
          variant="default"
          onClick={handleSaveAsDraft}
          loading={savingDraft}
          disabled={!features.canWrite}
        >
          Save as Draft
        </Button>
      )}

      {showReorder && <ReorderImagesButton />}

      {/*
        Always show the View button (gated only by having ≥1 image). Owners
        can preview how the post will render to the public even while it's
        still a draft or hidden via parent-unpublish — useful for staging
        + reviewing changes before publishing.
      */}
      {images.length > 0 && (
        <Button
          onClick={() => {
            const [image] = images;
            if (images.length > 1) {
              if (collectionId) router.replace(`/posts/${post.id}`);
              else router.push(`/posts/${post.id}`);
            } else if (images.length === 1 && image && 'id' in image.data) {
              if (collectionId) router.replace(`/images/${image.data.id}`);
              else router.push(`/images/${image.data.id}`);
            }
          }}
          variant="outline"
          color="blue"
        >
          View {postLabel}
        </Button>
      )}

      <PlacementSpaceToggle level="post" entityId={post.id} />

      <DeletePostButton postId={post.id}>
        {({ onClick, isLoading }) => (
          <Button
            onClick={() => {
              setDeleted(true);
              onClick();
            }}
            color="red"
            loading={isLoading}
            variant="outline"
            leftSection={<IconTrash size={20} />}
            disabled={!features.canWrite}
          >
            Delete Post
          </Button>
        )}
      </DeletePostButton>
    </>
  );
}

const tooltipProps: Partial<TooltipProps> = {
  maw: 300,
  multiline: true,
  position: 'bottom',
  withArrow: true,
};
