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
import { matureLabel } from '~/components/Post/Edit/EditPostControls';
import { useFormStorage } from '~/hooks/useFormStorage';
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
import { upsertClubTierInput } from '~/server/schema/club.schema';
import { useMutateClub } from '~/components/Club/club.utils';
import { constants } from '~/server/common/constants';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { ClubTier } from '~/types/router';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';

const tooltipProps: Partial<TooltipProps> = {
  maw: 300,
  multiline: true,
  position: 'bottom',
  withArrow: true,
};

const formSchema = upsertClubTierInput;

export function ClubTierUpsertForm({
  clubTier,
  clubId,
  onSuccess,
  onCancel,
}: {
  clubTier?: ClubTier;
  clubId: number;
  onSuccess?: () => void;
  onCancel?: () => void;
}) {
  const form = useForm({
    schema: formSchema,
    defaultValues: {
      unlisted: false,
      joinable: true,
      ...clubTier,
      clubId,
    },
    shouldUnregister: false,
  });

  const [coverImage] = form.watch(['coverImage']);

  const { upsertClubTier, upsertingTier } = useMutateClub();
  const handleSubmit = async (data: z.infer<typeof formSchema>) => {
    try {
      await upsertClubTier({
        ...data,
      });

      onSuccess?.();
    } catch (error) {
      // Do nothing since the query event will show an error notification
    }
  };

  return (
    <Form form={form} onSubmit={handleSubmit}>
      <Stack spacing={32}>
        <Grid gutter="xl">
          <Grid.Col xs={12}>
            <Stack spacing={32}>
              <Stack spacing="xl">
                <InputText name="name" label="Title" placeholder="e.g.: Gold Tier" withAsterisk />
                <InputNumber
                  name="unitAmount"
                  placeholder={`Min. ${constants.clubs.minMonthlyBuzz} BUZZ`}
                  label="Monthly buzz"
                  variant="filled"
                  min={constants.clubs.minMonthlyBuzz}
                  icon={<CurrencyIcon currency="BUZZ" size={16} />}
                  withAsterisk
                />
                <InputRTE
                  name="description"
                  label="Tier benefits"
                  editorSize="xl"
                  includeControls={['heading', 'formatting', 'list', 'link', 'media', 'colors']}
                  withAsterisk
                  stickyToolbar
                />
                <Group grow>
                  {coverImage && (
                    <div
                      style={{
                        position: 'relative',
                        width: constants.clubs.tierImageDisplayWidth,
                        flexGrow: 0,
                      }}
                    >
                      <Avatar
                        src={getEdgeUrl(coverImage?.url, { transcode: false })}
                        size={constants.clubs.tierImageDisplayWidth}
                        radius="sm"
                      />
                      <Tooltip label="Remove image">
                        <ActionIcon
                          size="sm"
                          variant="filled"
                          color="red"
                          onClick={() =>
                            form.setValue('coverImage', clubTier?.coverImage?.id ? null : undefined)
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
                    label="Tier's cover image"
                    aspectRatio={constants.clubs.tierImageAspectRatio}
                    previewWidth={constants.clubs.tierImageDisplayWidth}
                    previewDisabled
                    style={{ maxWidth: '100%' }}
                  />
                </Group>
                <InputSwitch
                  name="unlisted"
                  label={
                    <Stack spacing={4}>
                      <Group spacing={4}>
                        <Text inline>Unlisted</Text>
                      </Group>
                      <Text size="xs" color="dimmed">
                        This tier will not be displayed to users directly, but they can join it if
                        they have the link.
                      </Text>
                    </Stack>
                  }
                />
                <InputSwitch
                  name="joinable"
                  label={
                    <Stack spacing={4}>
                      <Group spacing={4}>
                        <Text inline>Joinable</Text>
                      </Group>
                      <Text size="xs" color="dimmed">
                        This tier will not be joinable by users, regardless of whether they have a
                        link or not. This is useful to create tiers that are only available to users
                        you want to invite and to start working on a tier before other users get
                        access to it.
                      </Text>
                    </Stack>
                  }
                />
              </Stack>
            </Stack>
          </Grid.Col>
        </Grid>
        <Group position="right">
          {onCancel && (
            <Button
              loading={upsertingTier}
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
          <Button loading={upsertingTier} type="submit">
            Save
          </Button>
        </Group>
      </Stack>
    </Form>
  );
}
