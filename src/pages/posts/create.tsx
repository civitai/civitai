import {
  Anchor,
  Card,
  Center,
  Container,
  Group,
  Loader,
  Select,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { IconLock } from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useRef } from 'react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { createPage } from '~/components/AppLayout/createPage';
import { BackButton } from '~/components/BackButton/BackButton';
import { FeatureIntroductionHelpButton } from '~/components/FeatureIntroduction/FeatureIntroduction';
import { PostEditLayout } from '~/components/Post/EditV2/PostEditLayout';
import { PostImageDropzone } from '~/components/Post/EditV2/PostImageDropzone';
import {
  EditUserResourceReviewV2,
  ReviewEditCommandsRef,
  UserResourceReviewComposite,
} from '~/components/ResourceReview/EditUserResourceReview';
import { ResourceReviewThumbActions } from '~/components/ResourceReview/ResourceReviewThumbActions';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { postEditQuerySchema } from '~/server/schema/post.schema';
import { trpc } from '~/utils/trpc';

export default createPage(
  function PostCreate() {
    const currentUser = useCurrentUser();
    const router = useRouter();
    const params = postEditQuerySchema.parse(router.query);
    const { modelId, modelVersionId, tag: tagId, video: postingVideo, clubId, reviewing } = params;

    const isMuted = currentUser?.muted ?? false;
    const displayReview = !isMuted && !!reviewing && !!modelVersionId && !!modelId;
    const reviewEditRef = useRef<ReviewEditCommandsRef | null>(null);

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
                <Text size="md">
                  You cannot create a post because your account has been restricted.
                </Text>
              </AlertWithIcon>
            </Stack>
          </Center>
        </Container>
      );

    return (
      <Container size="xs" className="flex flex-col gap-3">
        <div className="flex justify-between items-center">
          <BackButton url={backButtonUrl} />
          <Title>
            {displayReview ? 'Create a Review' : `Create ${postingVideo ? 'Video' : 'Image'} Post`}
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

        <PostImageDropzone
          showProgress={false}
          onCreatePost={async (post) => {
            await router.replace({
              pathname: `/posts/${post.id}/edit`,
              query: { ...params },
            });
          }}
        />
      </Container>
    );
  },
  { InnerLayout: PostEditLayout }
);
