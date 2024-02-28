import {
  Anchor,
  Box,
  Center,
  Container,
  Group,
  Input,
  Loader,
  Select,
  Stack,
  Text,
  Title,
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
  EditUserResourceReview,
  ReviewEditCommandsRef,
} from '~/components/ResourceReview/EditUserResourceReview';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { POST_IMAGE_LIMIT } from '~/server/common/constants';
import { IMAGE_MIME_TYPE, VIDEO_MIME_TYPE } from '~/server/common/mime-types';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export default function PostCreate() {
  const currentUser = useCurrentUser();
  const router = useRouter();
  const tagId = router.query.tag ? Number(router.query.tag) : undefined;
  const modelId = router.query.modelId ? Number(router.query.modelId) : undefined;
  const modelVersionId = router.query.modelVersionId
    ? Number(router.query.modelVersionId)
    : undefined;
  const clubId = router.query.clubId ? Number(router.query.clubId) : undefined;
  const postingVideo = router.query.video != null;

  const reviewing = router.query.reviewing ? router.query.reviewing === 'true' : undefined;
  const isMuted = currentUser?.muted ?? false;
  const displayReview = !isMuted && !!reviewing && !!modelVersionId && !!modelId;
  const reviewEditRef = useRef<ReviewEditCommandsRef | null>(null);

  const reset = useEditPostContext((state) => state.reset);
  const images = useEditPostContext((state) => state.images);
  const upload = useEditPostContext((state) => state.upload);
  const queryUtils = trpc.useUtils();

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

  const [selected, setSelected] = useState<string | undefined>(modelVersionId?.toString());

  const { mutate, isLoading } = trpc.post.create.useMutation();
  const handleDrop = (files: File[]) => {
    const versionId = selected ? Number(selected) : modelVersionId;
    const title =
      reviewing && version ? `${version.model.name} - ${version.name} Review` : undefined;

    reviewEditRef.current?.save();

    mutate(
      { modelVersionId: versionId, title, tag: tagId },
      {
        onSuccess: async (response) => {
          reset(response);
          const postId = response.id;
          queryUtils.post.getEdit.setData({ id: postId }, () => response);
          upload({ postId, modelVersionId: versionId }, files);
          const returnUrl = router.query.returnUrl as string;
          let pathname = `/posts/${postId}/edit`;
          const queryParams: string[] = [];
          if (returnUrl) queryParams.push(`returnUrl=${returnUrl}`);
          if (reviewing) queryParams.push('reviewing=true');
          if (clubId) queryParams.push(`clubId=${clubId}`);
          if (queryParams.length > 0) pathname += `?${queryParams.join('&')}`;

          await router.push(pathname);
        },
        onError(error) {
          showErrorNotification({
            title: 'Failed to create post',
            error: new Error(error.message),
          });
        },
      }
    );
  };

  let backButtonUrl = modelId ? `/models/${modelId}` : '/';
  if (modelVersionId) backButtonUrl += `?modelVersionId=${modelVersionId}`;
  if (tagId) backButtonUrl = `/posts?tags=${tagId}&view=feed`;
  if (clubId) backButtonUrl = `/clubs/${clubId}`;

  const loading = (loadingCurrentUserReview || versionLoading) && !currentUserReview && !version;

  return (
    <Container size="xs">
      <Group spacing="xs" mb="md" noWrap>
        <BackButton url={backButtonUrl} />
        <Title>
          {displayReview ? 'Create a Review' : `Create ${postingVideo ? 'Video' : 'Image'} Post`}
        </Title>
        <FeatureIntroductionHelpButton
          feature="post-create"
          contentSlug={['feature-introduction', 'post-images']}
        />
      </Group>
      {currentUser?.muted ? (
        <Container size="xs">
          <Center p="xl">
            <Stack align="center">
              <AlertWithIcon color="yellow" icon={<IconLock />} iconSize={32} iconColor="yellow">
                <Text size="md">You cannot create a post because your account has been muted.</Text>
              </AlertWithIcon>
            </Stack>
          </Center>
        </Container>
      ) : (
        <Stack spacing={8}>
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
              value={selected}
              nothingFound={versionsLoading ? 'Loading...' : 'No resources found'}
              data={versions.map(({ id, name }) => ({ label: name, value: id.toString() }))}
              onChange={(value) => {
                if (value) setSelected(value);
              }}
            />
          )}
          {displayReview && version && (
            <>
              <Input.Wrapper label="What did you think of this resource?">
                <Box mt={5}>
                  <EditUserResourceReview
                    modelVersionId={version.id}
                    modelId={version.model.id}
                    modelName={version.model.name}
                    modelVersionName={version.name}
                    resourceReview={currentUserReview}
                    openedCommentBox
                    innerRef={reviewEditRef}
                  />
                </Box>
              </Input.Wrapper>
              {currentUserReview && (
                <Text size="sm" color="dimmed">
                  {`We've saved your review. Now, consider adding images below to create a post showcasing the resource.`}
                </Text>
              )}
            </>
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
          <ImageDropzone
            mt="md"
            onDrop={handleDrop}
            loading={isLoading}
            count={images.length}
            max={POST_IMAGE_LIMIT}
            accept={[...IMAGE_MIME_TYPE, ...VIDEO_MIME_TYPE]}
          />
          <Text size="xs">
            By uploading images to our site you agree to our{' '}
            <Anchor href="/content/tos" target="_blank" rel="nofollow" span>
              Terms of service
            </Anchor>
            . Be sure to read our <ContentPolicyLink /> before uploading any images.
          </Text>
        </Stack>
      )}
    </Container>
  );
}

setPageOptions(PostCreate, { innerLayout: PostEditLayout });
