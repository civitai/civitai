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
} from '@mantine/core';
import { IconTrash } from '@tabler/icons-react';
import React, { useState } from 'react';

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
import { upsertClubPostInput } from '~/server/schema/club.schema';
import { useMutateClub } from '~/components/Club/club.utils';
import { constants } from '~/server/common/constants';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { ClubPostGetAll, ClubTier } from '~/types/router';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';

const formSchema = upsertClubPostInput;

export function ClubPostUpsertForm({
  clubPost,
  clubId,
  onSuccess,
  onCancel,
}: {
  clubPost?: ClubPostGetAll[number];
  clubId: number;
  onSuccess?: () => void;
  onCancel?: () => void;
}) {
  const form = useForm({
    schema: formSchema,
    defaultValues: {
      ...clubPost,
      clubId,
    },
    shouldUnregister: false,
  });

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
