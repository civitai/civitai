import {
  Anchor,
  Card,
  Center,
  Container,
  Group,
  Loader,
  Select,
  Skeleton,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { IconAlertCircle, IconCube, IconLock } from '@tabler/icons-react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useRouter } from 'next/router';
import { useRef } from 'react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { Page } from '~/components/AppLayout/Page';
import { BackButton } from '~/components/BackButton/BackButton';
import { CollectionUploadSettingsWrapper } from '~/components/Collections/components/CollectionUploadSettingsWrapper';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { PostEditLayout } from '~/components/Post/EditV2/PostEditLayout';
import { PostImageDropzone } from '~/components/Post/EditV2/PostImageDropzone';
import { UserAvatarSimple } from '~/components/UserAvatar/UserAvatarSimple';
import type { ReviewEditCommandsRef } from '~/components/ResourceReview/EditUserResourceReview';
import {
  EditUserResourceReviewV2,
  UserResourceReviewComposite,
} from '~/components/ResourceReview/EditUserResourceReview';
import { ResourceReviewThumbActions } from '~/components/ResourceReview/ResourceReviewThumbActions';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { postEditQuerySchema } from '~/server/schema/post.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { getModelUrl } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';
import { removeDuplicates } from '~/utils/array-helpers';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, ctx }) => {
    if (!session)
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl, reason: 'post-images' }),
          permanent: false,
        },
      };
  },
});

export default Page(
  function () {
    const currentUser = useCurrentUser();
    const router = useRouter();
    const params = postEditQuerySchema.parse(router.query);
    const {
      modelId,
      modelVersionId,
      model3dId,
      tag: tagId,
      video: postingVideo,
      clubId,
      reviewing,
      collections: collectionIds,
      collectionId,
    } = params;

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

    const { data: model3d, isLoading: model3dLoading } = trpc.model3d.getById.useQuery(
      { id: model3dId ?? 0 },
      { enabled: !!model3dId }
    );

    const { data: currentUserReview, isLoading: loadingCurrentUserReview } =
      trpc.resourceReview.getUserResourceReview.useQuery(
        { modelVersionId: modelVersionId ?? 0 },
        { enabled: !!currentUser && displayReview }
      );

    const collectionIdsAggregate = removeDuplicates(
      [collectionId, ...(collectionIds ?? [])].filter(isDefined)
    );

    let backButtonUrl = modelId
      ? getModelUrl({ modelId, modelName: version?.model.name, modelVersionId })
      : '/';

    if (model3dId) backButtonUrl = `/3d-models/${model3dId}`;
    if (tagId) backButtonUrl = `/posts?tags=${tagId}&view=feed`;
    if (clubId) backButtonUrl = `/clubs/${clubId}`;
    if (collectionIds?.length)
      backButtonUrl =
        collectionIds.length > 1 ? `/collections` : `/collections/${collectionIds[0]}`;
    if (collectionId) backButtonUrl = `/collections/${collectionId}`;

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
      <CollectionUploadSettingsWrapper collectionIds={collectionIdsAggregate}>
        <Container size="xs" className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <BackButton url={backButtonUrl} />
              <Title>
                {displayReview
                  ? 'Create a Review'
                  : (collectionIdsAggregate?.length ?? 0) > 0
                  ? 'Submit Entry'
                  : `Create ${postingVideo ? 'Video' : 'Image'} Post`}
              </Title>
            </div>
          </div>
          {tagId && (tag || tagLoading) && (
            <Group gap="xs">
              {tagLoading && <Loader size="sm" />}
              <Text size="sm" c="dimmed">
                Posting to{' '}
                <Text component="span" td="underline">
                  {tag?.name}
                </Text>
              </Text>
            </Group>
          )}
          {modelVersionId && (version || loading) && (
            <Group gap="xs">
              {loading && <Loader size="sm" />}
              <Text size="sm" c="dimmed">
                Posting to{' '}
                <Text component="span" td="underline">
                  {version?.model.name} - {version?.name}
                </Text>
              </Text>
            </Group>
          )}
          {model3dId && model3dLoading && !model3d && (
            <Card withBorder p="sm" radius="md">
              <Group gap="sm" wrap="nowrap">
                <Skeleton height={56} width={56} radius="sm" />
                <Stack gap={6} className="min-w-0 flex-1">
                  <Skeleton height={14} width="70%" radius="sm" />
                  <Skeleton height={10} width="50%" radius="sm" />
                </Stack>
                <Loader size="xs" />
              </Group>
            </Card>
          )}
          {model3dId && model3d && (
            <Card withBorder p="sm" radius="md">
              <Stack gap={8}>
                <Group gap="sm" wrap="nowrap" align="flex-start">
                  <Link legacyBehavior href={`/3d-models/${model3d.id}`} passHref>
                    <Anchor className="shrink-0">
                      <div
                        className="flex items-center justify-center overflow-hidden rounded-sm bg-gray-1 dark:bg-dark-6"
                        style={{ width: 56, height: 56 }}
                      >
                        {model3d.thumbnailImage?.url ? (
                          <EdgeMedia
                            src={model3d.thumbnailImage.url}
                            width={112}
                            alt={model3d.name ?? '3D model thumbnail'}
                            className="size-full object-cover"
                          />
                        ) : (
                          <ThemeIcon variant="light" color="gray" size={56} radius="sm">
                            <IconCube size={28} />
                          </ThemeIcon>
                        )}
                      </div>
                    </Anchor>
                  </Link>
                  <Stack gap={2} className="min-w-0 flex-1">
                    <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                      Posting to 3D model
                    </Text>
                    <Link legacyBehavior href={`/3d-models/${model3d.id}`} passHref>
                      <Anchor size="md" fw={600} lineClamp={2} className="break-words">
                        {model3d.name}
                      </Anchor>
                    </Link>
                    <Text size="xs" c="dimmed">
                      This post will appear on the 3D model&apos;s page
                    </Text>
                  </Stack>
                </Group>
                <UserAvatarSimple
                  id={model3d.user.id}
                  profilePicture={model3d.user.profilePicture}
                  username={model3d.user.username}
                  deletedAt={model3d.user.deletedAt}
                  cosmetics={model3d.user.cosmetics}
                />
              </Stack>
            </Card>
          )}
          {versions && !reviewing && (
            <Select
              description="Select a resource to ensure that all uploaded images receive correct resource attribution"
              placeholder="Select a resource"
              value={modelVersionId ? String(modelVersionId) : undefined}
              nothingFoundMessage={versionsLoading ? 'Loading...' : 'No resources found'}
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
                    <Stack gap={8}>
                      <Text size="md" fw={600}>
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
                    <Text size="sm" c="dimmed">
                      {`We've saved your review. Now, consider adding images below to create a post showcasing the resource.`}
                    </Text>
                  )}
                </>
              )}
            </UserResourceReviewComposite>
          )}
          <AlertWithIcon icon={<IconAlertCircle />}>
            There may be a short delay before your uploaded media appears in the Model Gallery and
            Feeds. Please allow a few minutes for your media to become visible after posting.
          </AlertWithIcon>
          {!displayReview && (
            <Text size="xs" c="dimmed">
              Our site is mostly used for sharing AI generated content. You can start generating
              content using our{' '}
              <Link legacyBehavior href="/generate" passHref>
                <Anchor>onsite generator</Anchor>
              </Link>{' '}
              or train your model using your own content by using our{' '}
              <Link legacyBehavior href="/models/train" passHref>
                <Anchor>onsite trainer</Anchor>
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
      </CollectionUploadSettingsWrapper>
    );
  },
  { InnerLayout: PostEditLayout }
);
