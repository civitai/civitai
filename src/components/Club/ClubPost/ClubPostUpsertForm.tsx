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
  Select,
} from '@mantine/core';
import { IconTrash } from '@tabler/icons-react';
import React, { useEffect, useMemo, useState } from 'react';

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
import { useMutateClub, useQueryUserContributingClubs } from '~/components/Club/club.utils';
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
import { ClubAdminPermission } from '@prisma/client';
import { ClubPostResourceCard } from './ClubFeed';

const formSchema = upsertClubPostInput.refine(
  (data) => {
    if (data.entityType !== 'Post' && !(data.title && data.description)) {
      return false;
    }

    return true;
  },
  {
    message: 'Title and description are required',
    path: ['title'],
  }
);

type Props = {
  resource?: {
    entityId: number;
    entityType: SupportedClubPostEntities;
  };
  clubPost?: Omit<ClubPostGetAll[number], 'metrics' | 'reactions'>;
  clubId: number;
  onSuccess?: () => void;
  onCancel?: () => void;
};

export function ClubPostUpsertForm({ clubPost, clubId, onSuccess, onCancel, resource }: Props) {
  const currentUser = useCurrentUser();
  const form = useForm({
    schema: formSchema,
    defaultValues: {
      membersOnly: true,
      ...resource,
      ...clubPost,
      clubId,
    },
    shouldUnregister: false,
  });

  const [entityId, entityType, title] = form.watch(['entityId', 'entityType', 'title']);
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
    }
  }, [entityId, entityType, resourceData]);

  return (
    <Form form={form} onSubmit={handleSubmit}>
      <Stack spacing="md">
        <Stack spacing="md">
          <InputSimpleImageUpload
            name="coverImage"
            label="Post cover image"
            previewWidth={300}
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
            label={
              resource
                ? 'This resource will be linked to the club post'
                : 'Link a resource to this post'
            }
            description="By linking a resource to the club post, the resource card will be displayed in your club feed and post. This will not affect the resource permissions or access. If someone with no access to this resource happens upon your club post, they will not be able to see it."
          >
            <Divider mt="md" size={0} />
            <Stack>
              {currentUser?.username && !resource && !entityId && !entityType && (
                <QuickSearchDropdown
                  // Match SupportedClubEntities here.
                  supportedIndexes={['models', 'articles']}
                  onItemSelected={(item) => {
                    form.setValue('entityId', item.entityId);
                    form.setValue('entityType', item.entityType as SupportedClubPostEntities);
                  }}
                  dropdownItemLimit={25}
                />
              )}
              {resourceData && <ClubPostResourceCard resourceData={resourceData} />}
              {entityId && entityType && isLoadingResource && (
                <Center>
                  <Loader />
                </Center>
              )}
              {resourceData && !resource && (
                <Button
                  variant="outline"
                  color="red"
                  onClick={() => {
                    form.setValue('entityId', null);
                    form.setValue('entityType', null);
                  }}
                >
                  Remove resource
                </Button>
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

export const ClubPostFromResourceModal = ({
  entityId,
  entityType,
}: {
  entityId: number;
  entityType: SupportedClubPostEntities;
}) => {
  const currentUser = useCurrentUser();
  const { userClubs, isLoading: isLoadingUserClubs } = useQueryUserContributingClubs();
  const canCreateClubPostClubs = useMemo(() => {
    return (
      userClubs?.filter(
        (club) =>
          club.userId === currentUser?.id ||
          club.admin?.permissions.includes(ClubAdminPermission.ManagePosts)
      ) ?? []
    );
  }, [userClubs, currentUser]);
  const [selectedClubId, setSelectedClubId] = useState<number | null>(null);

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
    <Modal {...dialog} size="lg" withCloseButton title="Create club post from this resource">
      <Stack>
        <Divider mx="-lg" />
        {isLoadingUserClubs && (
          <Center>
            <Loader variant="bars" />
          </Center>
        )}
        {canCreateClubPostClubs?.length > 0 ? (
          <Select
            label="What club do you want to add this post to?"
            data={canCreateClubPostClubs.map((club) => ({
              value: club.id.toString(),
              label: club.name,
            }))}
            value={selectedClubId?.toString() ?? ''}
            onChange={(clubId: string) => setSelectedClubId(Number(clubId))}
          />
        ) : (
          <Text size="sm" color="dimmed">
            You are not a member of, or own, any clubs that allow you to create posts.
          </Text>
        )}

        {selectedClubId && (
          <ClubPostUpsertForm
            clubId={selectedClubId}
            resource={{ entityId, entityType }}
            onCancel={handleClose}
            onSuccess={handleSuccess}
          />
        )}
      </Stack>
    </Modal>
  );
};

export const ClubPostUpsertFormModal = (props: {
  clubId: number;
  resource?: {
    entityId: number;
    entityType: SupportedClubPostEntities;
  };
}) => {
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
