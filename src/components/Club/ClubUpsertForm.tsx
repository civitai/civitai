import {
  Alert,
  Button,
  Group,
  Stack,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
  TooltipProps,
  SimpleGrid,
  Paper,
  ActionIcon,
  Progress,
  Divider,
  Input,
  Radio,
  createStyles,
  Grid,
  Anchor,
  List,
  Avatar,
  Box,
} from '@mantine/core';
import { BountyEntryMode, BountyMode, BountyType, Currency, TagTarget } from '@prisma/client';
import {
  IconCalendar,
  IconCalendarDue,
  IconExclamationMark,
  IconInfoCircle,
  IconQuestionMark,
  IconTrash,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';
import React, { useState } from 'react';

import { BackButton, NavigateBack } from '~/components/BackButton/BackButton';
import { useFormStorage } from '~/hooks/useFormStorage';
import {
  Form,
  InputRTE,
  InputSimpleImageUpload,
  InputSwitch,
  InputText,
  useForm,
} from '~/libs/form';
import { z } from 'zod';
import { upsertClubInput } from '~/server/schema/club.schema';
import { useMutateClub } from '~/components/Club/club.utils';
import { constants } from '~/server/common/constants';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { getInitials } from '~/utils/string-helpers';
import { ClubGetById } from '~/types/router';
import { openBrowsingLevelGuide } from '~/components/Dialog/dialog-registry';

const tooltipProps: Partial<TooltipProps> = {
  maw: 300,
  multiline: true,
  position: 'bottom',
  withArrow: true,
};

const formSchema = upsertClubInput;

export function ClubUpsertForm({
  club,
  onSave,
}: {
  club?: ClubGetById;
  onSave?: (club: { id: number }) => void;
}) {
  const form = useForm({
    schema: formSchema,
    defaultValues: {
      ...(club ?? {}),
    },
    shouldUnregister: false,
  });

  const [avatar, coverImage] = form.watch(['avatar', 'coverImage']);

  const { upsertClub, upserting } = useMutateClub();
  const handleSubmit = async (data: z.infer<typeof formSchema>) => {
    try {
      const result = await upsertClub({
        ...data,
      });

      if (result?.id) {
        onSave?.(result);
      }
    } catch (error) {
      // Do nothing since the query event will show an error notification
    }
  };

  return (
    <Form form={form} onSubmit={handleSubmit}>
      <Stack spacing={32}>
        <Grid gutter="xl">
          <Grid.Col xs={12} md={8}>
            <Stack spacing={32}>
              <Stack spacing="xl">
                <InputText
                  name="name"
                  label="Title"
                  placeholder="e.g.:My Awesome Club"
                  withAsterisk
                />
                <InputRTE
                  name="description"
                  label="What's your club about?"
                  editorSize="xl"
                  includeControls={['heading', 'formatting', 'list', 'link', 'media', 'colors']}
                  withAsterisk
                  stickyToolbar
                />
                <Group grow noWrap>
                  {avatar && (
                    <div style={{ position: 'relative', width: 124, flexGrow: 0 }}>
                      <Avatar
                        src={getEdgeUrl(avatar?.url, { transcode: false })}
                        size={124}
                        radius="sm"
                      />
                      <Tooltip label="Remove image">
                        <ActionIcon
                          size="sm"
                          variant="filled"
                          color="red"
                          onClick={() =>
                            form.setValue('avatar', club?.avatar?.id ? null : undefined)
                          }
                          sx={(theme) => ({
                            position: 'absolute',
                            top: theme.spacing.xs * 0.4,
                            right: theme.spacing.xs * 0.4,
                            zIndex: 1,
                          })}
                        >
                          <IconTrash />
                        </ActionIcon>
                      </Tooltip>
                    </div>
                  )}
                  <InputSimpleImageUpload
                    name="avatar"
                    label="Club Avatar"
                    description="This will appear on your club's header as your club's avatar. Only people who enter your club's feed will see this image. Ideal resolution is 1024x1024."
                    aspectRatio={1}
                    // Im aware ideally this should ideally be 450, but images will look better on a higher res here
                    previewWidth={96}
                    previewDisabled
                    style={{ maxWidth: '100%' }}
                  />
                </Group>
                <Group grow noWrap>
                  {coverImage && (
                    <div style={{ position: 'relative', width: 124, flexGrow: 0 }}>
                      <Avatar
                        src={getEdgeUrl(coverImage?.url, { transcode: false })}
                        size={124}
                        radius="sm"
                      />
                      <Tooltip label="Remove image">
                        <ActionIcon
                          size="sm"
                          variant="filled"
                          color="red"
                          onClick={() =>
                            form.setValue('coverImage', club?.coverImage?.id ? null : undefined)
                          }
                          sx={(theme) => ({
                            position: 'absolute',
                            top: theme.spacing.xs * 0.4,
                            right: theme.spacing.xs * 0.4,
                            zIndex: 1,
                          })}
                        >
                          <IconTrash />
                        </ActionIcon>
                      </Tooltip>
                    </div>
                  )}
                  <InputSimpleImageUpload
                    name="coverImage"
                    label="Cover Image"
                    description="This will appear in the main feed as your club's cover image. Make sure to use a really eye catching image! Ideal resolution is 1024x1024."
                    aspectRatio={1}
                    // Im aware ideally this should ideally be 450, but images will look better on a higher res here
                    previewWidth={96}
                    previewDisabled
                    style={{ maxWidth: '100%' }}
                  />
                </Group>
                <InputSimpleImageUpload
                  name="headerImage"
                  label="Banner Image"
                  description={`Suggested resolution: ${constants.clubs.coverImageWidth}x${constants.clubs.coverImageHeight}px`}
                  aspectRatio={constants.clubs.headerImageAspectRatio}
                  previewWidth={constants.profile.coverImageWidth}
                />
              </Stack>
            </Stack>
          </Grid.Col>
          <Grid.Col xs={12} md={4}>
            <Stack>
              <Divider label="Properties" />
              <InputSwitch
                name="nsfw"
                label={
                  <Stack spacing={4}>
                    <Group spacing={4}>
                      <Text inline>Mature theme</Text>

                      <ActionIcon
                        radius="xl"
                        size="xs"
                        color="gray"
                        onClick={openBrowsingLevelGuide}
                      >
                        <IconQuestionMark />
                      </ActionIcon>
                    </Group>
                    <Text size="xs" color="dimmed">
                      This club is intended to produce mature content. A badge will be added to the
                      club&rsquo;s card on the main feed.
                    </Text>
                  </Stack>
                }
              />
              <InputSwitch
                name="unlisted"
                label={
                  <Stack spacing={4}>
                    <Group spacing={4}>
                      <Text inline>Unlisted</Text>
                    </Group>
                    <Text size="xs" color="dimmed">
                      This club should not appear in the main feed
                    </Text>
                  </Stack>
                }
              />
              {club?.id && (
                <InputSwitch
                  name="billing"
                  label={
                    <Stack spacing={4}>
                      <Group spacing={4}>
                        <Text inline>Renew Memberships Monthly</Text>
                        <Tooltip
                          label="By disabling billing, people will keep their memberships but won't be charged monthly. This is useful if you're not planning to add content for a while."
                          {...tooltipProps}
                        >
                          <ThemeIcon radius="xl" size="xs" color="gray">
                            <IconQuestionMark />
                          </ThemeIcon>
                        </Tooltip>
                      </Group>
                      <Text size="xs" color="dimmed">
                        Members of your club will be charged a monthly fee to keep access to your
                        club. Turning this off does not affect the initial membership fee.
                      </Text>
                    </Stack>
                  }
                />
              )}
              <Text size="xs">
                Clubs MUST adhere to the content rules defined in our{' '}
                <Anchor href="/content/tos" target="_blank" rel="nofollow" span>
                  Terms of service
                </Anchor>
                .
              </Text>
            </Stack>
          </Grid.Col>
        </Grid>
        <Group position="right">
          <Button loading={upserting} type="submit">
            Save
          </Button>
        </Group>
      </Stack>
    </Form>
  );
}
