import {
  Anchor,
  Center,
  Container,
  Group,
  Loader,
  Select,
  Stack,
  Text,
  Title,
  Card,
} from '@mantine/core';
import { IconLock } from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useRef, useState } from 'react';

import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { setPageOptions } from '~/components/AppLayout/AppLayout';
import { BackButton } from '~/components/BackButton/BackButton';
import { ContentPolicyLink } from '~/components/ContentPolicyLink/ContentPolicyLink';
import { FeatureIntroductionHelpButton } from '~/components/FeatureIntroduction/FeatureIntroduction';
import { ImageDropzone } from '~/components/Image/ImageDropzone/ImageDropzone';
import { useEditPostContext } from '~/components/Post/Edit/EditPostProvider';
import { PostEditLayout } from '~/components/Post/Edit/PostEditLayout';
import {
  ReviewEditCommandsRef,
  EditUserResourceReviewV2,
  UserResourceReviewComposite,
} from '~/components/ResourceReview/EditUserResourceReview';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { ResourceReviewThumbActions } from '~/components/ResourceReview/ResourceReviewThumbActions';
import { z } from 'zod';
import { PostEditProvider } from '~/components/Post/EditV2/PostEditProvider';
import { postEditQuerySchema } from '~/server/schema/post.schema';
import {
  getBrowserRouter,
  useBrowserRouter,
} from '~/components/BrowserRouter/BrowserRouterProvider';

export default function PostCreate() {
  const currentUser = useCurrentUser();
  const router = useRouter();
  const browserRouter = useBrowserRouter();
  const params = postEditQuerySchema.parse({ ...router.query, ...browserRouter.query });
  const {
    modelId,
    modelVersionId,
    tag: tagId,
    video: postingVideo,
    clubId,
    reviewing,
    postId,
  } = params;

  const isMuted = currentUser?.muted ?? false;
  const displayReview = !isMuted && !!reviewing && !!modelVersionId && !!modelId;
  const reviewEditRef = useRef<ReviewEditCommandsRef | null>(null);
  const view = !postId ? 'create' : 'edit';

  const { data: versions, isLoading: versionsLoading } = trpc.model.getVersions.useQuery(
    { id: modelId ?? 0, excludeUnpublished: true },
    { enabled: !!modelId && !reviewing }
  );

  const { data: version, isLoading: versionLoading } = trpc.modelVersion.getById.useQuery(
    { id: modelVersionId ?? 0 },
    { enabled: !!modelVersionId }
  );

  const { data: tag, isLoading: tagLoading } = trpc.tag.getById.useQuery(
    { id: tagId ?? 0 },
    { enabled: !!tagId }
  );
  const { data: currentUserReview, isLoading: loadingCurrentUserReview } =
    trpc.resourceReview.getUserResourceReview.useQuery(
      { modelVersionId: modelVersionId ?? 0 },
      { enabled: !!currentUser && displayReview }
    );

  // const { mutate, isLoading } = trpc.post.create.useMutation();
  // const handleDrop = (files: File[]) => {
  //   const versionId = selected ? Number(selected) : modelVersionId;
  //   const title =
  //     reviewing && version ? `${version.model.name} - ${version.name} Review` : undefined;

  //   reviewEditRef.current?.save();

  //   mutate(
  //     { modelVersionId: versionId, title, tag: tagId },
  //     {
  //       onSuccess: async (response) => {
  //         reset(response);
  //         const postId = response.id;
  //         queryUtils.post.getEdit.setData({ id: postId }, () => response);
  //         upload({ postId, modelVersionId: versionId }, files);

  //         let pathname = `/posts/${postId}/edit`;
  //         const queryParams: string[] = [];
  //         if (returnUrl) queryParams.push(`returnUrl=${returnUrl}`);
  //         if (reviewing) queryParams.push('reviewing=true');
  //         if (clubId) queryParams.push(`clubId=${clubId}`);
  //         if (queryParams.length > 0) pathname += `?${queryParams.join('&')}`;

  //         await router.push(pathname);
  //       },
  //       onError(error) {
  //         showErrorNotification({
  //           title: 'Failed to create post',
  //           error: new Error(error.message),
  //         });
  //       },
  //     }
  //   );
  // };

  let backButtonUrl = modelId ? `/models/${modelId}` : '/';
  if (modelVersionId) backButtonUrl += `?modelVersionId=${modelVersionId}`;
  if (tagId) backButtonUrl = `/posts?tags=${tagId}&view=feed`;
  if (clubId) backButtonUrl = `/clubs/${clubId}`;

  const loading = (loadingCurrentUserReview || versionLoading) && !currentUserReview && !version;

  if (currentUser?.muted)
    return (
      <Container size="xs">
        <Center p="xl">
          <Stack align="center">
            <AlertWithIcon color="yellow" icon={<IconLock />} iconSize={32} iconColor="yellow">
              <Text size="md">You cannot create a post because your account has been muted.</Text>
            </AlertWithIcon>
          </Stack>
        </Center>
      </Container>
    );

  return (
    <Container size={view === 'create' ? 'xs' : 'xl'} className="flex flex-col gap-3">
      {view === 'create' && (
        <>
          <div className="flex justify-between items-center">
            <BackButton url={backButtonUrl} />
            <Title>
              {displayReview
                ? 'Create a Review'
                : `Create ${postingVideo ? 'Video' : 'Image'} Post`}
            </Title>
            <FeatureIntroductionHelpButton
              feature="post-create"
              contentSlug={['feature-introduction', 'post-images']}
            />
          </div>
          {tagId && (tag || tagLoading) && (
            <Group spacing="xs">
              {tagLoading && <Loader size="sm" />}
              <Text size="sm" color="dimmed">
                Posting to{' '}
                <Text component="span" td="underline">
                  {tag?.name}
                </Text>
              </Text>
            </Group>
          )}
          {modelVersionId && (version || loading) && (
            <Group spacing="xs">
              {loading && <Loader size="sm" />}
              <Text size="sm" color="dimmed">
                Posting to{' '}
                <Text component="span" td="underline">
                  {version?.model.name} - {version?.name}
                </Text>
              </Text>
            </Group>
          )}
          {versions && !reviewing && (
            <Select
              description="Select a resource to ensure that all uploaded images receive correct resource attribution"
              placeholder="Select a resource"
              value={modelVersionId ? String(modelVersionId) : undefined}
              nothingFound={versionsLoading ? 'Loading...' : 'No resources found'}
              data={versions.map(({ id, name }) => ({ label: name, value: id.toString() }))}
              onChange={(value) =>
                router.replace({ query: { ...params, modelVersionId: value } }, undefined, {
                  shallow: true,
                })
              }
            />
          )}
          {displayReview && version && (
            <UserResourceReviewComposite
              modelId={version.model.id}
              modelVersionId={version.id}
              modelName={version.model.name}
            >
              {({ modelId, modelVersionId, modelName, userReview }) => (
                <>
                  <Card p="sm" withBorder>
                    <Stack spacing={8}>
                      <Text size="md" weight={600}>
                        What did you think of this resource?
                      </Text>
                      <ResourceReviewThumbActions
                        modelId={modelId}
                        modelVersionId={modelVersionId}
                        userReview={userReview}
                        withCount
                      />
                    </Stack>
                    {userReview && (
                      <Card.Section py="sm" mt="sm" inheritPadding withBorder>
                        <EditUserResourceReviewV2
                          modelVersionId={modelVersionId}
                          modelName={modelName}
                          userReview={userReview}
                          innerRef={reviewEditRef}
                        />
                      </Card.Section>
                    )}
                  </Card>

                  {userReview && (
                    <Text size="sm" color="dimmed">
                      {`We've saved your review. Now, consider adding images below to create a post showcasing the resource.`}
                    </Text>
                  )}
                </>
              )}
            </UserResourceReviewComposite>
          )}
          {!displayReview && (
            <Text size="xs" color="dimmed">
              Our site is mostly used for sharing AI generated content. You can start generating
              images using our{' '}
              <Link href="/generate" passHref>
                <Anchor>onsite generator</Anchor>
              </Link>{' '}
              or train your model using your own images by using our{' '}
              <Link href="/models/train" passHref>
                <Anchor>onsite LoRA trainer</Anchor>
              </Link>
              .
            </Text>
          )}
        </>
      )}
      <PostEditProvider
        params={{ ...params, ...browserRouter.query }}
        onCreate={(post) => {
          browserRouter.replace({
            pathname: `/posts/${post.id}/edit`,
            query: { ...params, postId: post.id },
          });
        }}
      />
    </Container>
  );
}

// setPageOptions(PostCreate, { innerLayout: PostEditLayout });
