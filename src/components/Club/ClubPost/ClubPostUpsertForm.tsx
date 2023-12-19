import {
  Button,
  Group,
  Stack,
  Text,
  Tooltip,
  TooltipProps,
  ActionIcon,
  Grid,
  Avatar,
  Modal,
  Divider,
  Center,
  Loader,
  Box,
  Input,
} from '@mantine/core';
import { IconTrash } from '@tabler/icons-react';
import React, { useEffect, useState } from 'react';

import {
  Form,
  InputNumber,
  InputRTE,
  InputSimpleImageUpload,
  InputSwitch,
  InputText,
  useForm,
} from '~/libs/form';
import { z } from 'zod';
import {
  SupportedClubEntities,
  SupportedClubPostEntities,
  upsertClubPostInput,
} from '~/server/schema/club.schema';
import { useMutateClub } from '~/components/Club/club.utils';
import { constants } from '~/server/common/constants';
import { ClubPostGetAll, ClubPostResource, ClubTier } from '~/types/router';
import { showSuccessNotification } from '~/utils/notifications';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { trpc } from '../../../utils/trpc';
import { ModelCard } from '../../Cards/ModelCard';
import { ArticleCard } from '../../Cards/ArticleCard';
import { PostCard } from '../../Cards/PostCard';
import { QuickSearchDropdown } from '../../Search/QuickSearchDropdown';
import { useCurrentUser } from '../../../hooks/useCurrentUser';

const formSchema = upsertClubPostInput;

type Props = {
  clubPost?: ClubPostGetAll[number];
  clubId: number;
  onSuccess?: () => void;
  onCancel?: () => void;
};

export const ClubPostResourceCard = ({ resourceData }: { resourceData: ClubPostResource }) => {
  if (!resourceData.data) {
    return null;
  }

  switch (resourceData.entityType) {
    case 'Model':
    case 'ModelVersion':
      return (
        <ModelCard
          data={{ ...resourceData.data, image: resourceData?.data?.images[0] ?? null } as any}
        />
      );
    case 'Article':
      return <ArticleCard data={resourceData.data as any} />;
    case 'Post':
      return <PostCard data={resourceData.data as any} />;
    default:
      return null;
  }
};

export function ClubPostUpsertForm({ clubPost, clubId, onSuccess, onCancel }: Props) {
  const currentUser = useCurrentUser();
  const form = useForm({
    schema: formSchema,
    defaultValues: {
      membersOnly: true,
      ...clubPost,
      clubId,
    },
    shouldUnregister: false,
  });

  const [entityId, entityType, title, description] = form.watch([
    'entityId',
    'entityType',
    'title',
    'description',
  ]);
  const { data: resourceData, isLoading: isLoadingResource } =
    trpc.clubPost.resourcePostCreateDetails.useQuery(
      {
        entityId: entityId as number,
        entityType: entityType as SupportedClubEntities,
      },
      {
        enabled: !!entityId && !!entityType,
      }
    );

  const { upsertClubPost, upsertingClubPost } = useMutateClub();

  const handleSubmit = async (data: z.infer<typeof formSchema>) => {
    try {
      await upsertClubPost({
        ...data,
        clubId,
      });

      if (!data.id) {
        form.reset();
      }

      onSuccess?.();
    } catch (error) {
      // Do nothing since the query event will show an error notification
    }
  };

  useEffect(() => {
    if (resourceData && (entityId !== clubPost?.entityId || entityType !== clubPost?.entityType)) {
      // Resource changed, change our data. Fallback to current data if resource data is not available
      form.setValue('title', resourceData.title || title);
      form.setValue('description', resourceData.description || description);
    }
  }, [entityId, entityType, resourceData]);

  return (
    <Form form={form} onSubmit={handleSubmit}>
      <Stack spacing="md">
        <Stack spacing="md">
          <InputSimpleImageUpload
            name="coverImage"
            label="Post cover image"
            aspectRatio={constants.clubs.postCoverImageAspectRatio}
            previewWidth={1250}
            style={{ maxWidth: '100%' }}
          />
          <InputText
            name="title"
            label="Title"
            placeholder="e.g Welcome to my club!"
            withAsterisk
          />
          <InputRTE
            name="description"
            label="Content"
            editorSize="xl"
            includeControls={['heading', 'formatting', 'list', 'link', 'media', 'colors']}
            withAsterisk
            stickyToolbar
          />
          <Input.Wrapper
            label="Link one of your resources to this post:"
            description="By linking your resource, the resource card will be displayed in your club feed and post. This will not affect the resource permisisons or access. Your post title and description will be overwritten by the resource title and description."
          >
            <Divider mt="md" size={0} />
            <Stack>
              {currentUser?.username && (
                <QuickSearchDropdown
                  // Match SupportedClubEntities here.
                  supportedIndexes={['models', 'articles']}
                  onItemSelected={(item) => {
                    form.setValue('entityId', item.entityId);
                    form.setValue('entityType', item.entityType as SupportedClubPostEntities);
                  }}
                  filters={`user.username='${'theally' ?? currentUser.username}'`}
                  dropdownItemLimit={25}
                />
              )}
              {resourceData && (
                <Center>
                  <Box style={{ maxWidth: 250, width: '100%' }}>
                    <ClubPostResourceCard resourceData={resourceData} />
                  </Box>
                </Center>
              )}
              {entityId && entityType && isLoadingResource && (
                <Center>
                  <Loader />
                </Center>
              )}
            </Stack>
          </Input.Wrapper>
          <InputSwitch
            name="membersOnly"
            label={
              <Stack spacing={4}>
                <Group spacing={4}>
                  <Text inline>Members only</Text>
                </Group>
                <Text size="xs" color="dimmed">
                  This post will only be visible to members of this club. People browsing the club
                  without a membership will not be able to see this post.
                </Text>
              </Stack>
            }
          />
        </Stack>
        <Group position="right">
          {onCancel && (
            <Button
              loading={upsertingClubPost}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onCancel?.();
              }}
              color="gray"
            >
              Cancel
            </Button>
          )}
          <Button loading={upsertingClubPost} type="submit">
            Save
          </Button>
        </Group>
      </Stack>
    </Form>
  );
}

export const ClubPostUpsertFormModal = (props: { clubId: number }) => {
  const dialog = useDialogContext();
  const handleClose = dialog.onClose;
  const handleSuccess = () => {
    showSuccessNotification({
      title: 'Club post created',
      message: 'Your post was created and is now part of your club',
    });

    handleClose();
  };

  return (
    <Modal {...dialog} size="lg" withCloseButton title="Create new club post">
      <Stack>
        <Divider mx="-lg" />
        <ClubPostUpsertForm {...props} onCancel={handleClose} onSuccess={handleSuccess} />
      </Stack>
    </Modal>
  );
};
