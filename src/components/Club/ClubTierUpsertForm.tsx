import {
  ActionIcon,
  Avatar,
  Button,
  Grid,
  Group,
  Stack,
  Text,
  Tooltip,
  useMantineTheme,
} from '@mantine/core';
import { IconTrash } from '@tabler/icons-react';
import React from 'react';
import type * as z from 'zod/v4';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { useMutateClub } from '~/components/Club/club.utils';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

import {
  Form,
  InputNumber,
  InputRTE,
  InputSimpleImageUpload,
  InputSwitch,
  InputText,
  useForm,
} from '~/libs/form';
import { constants } from '~/server/common/constants';
import { upsertClubTierInput } from '~/server/schema/club.schema';
import type { ClubTier } from '~/types/router';

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
  const theme = useMantineTheme();
  const form = useForm({
    schema: formSchema,
    defaultValues: {
      unlisted: false,
      joinable: true,
      oneTimeFee: false,
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
      <Stack gap={32}>
        <Grid gutter="xl">
          <Grid.Col span={12}>
            <Stack gap={32}>
              <Stack gap="xl">
                <InputText name="name" label="Title" placeholder="e.g.: Gold Tier" withAsterisk />
                <InputNumber
                  name="unitAmount"
                  placeholder={`Min. ${constants.clubs.minMonthlyBuzz} Buzz. 0 for free tier`}
                  label="Monthly Buzz"
                  description="The amount of Buzz that will be charged to users every month. Updating this value will not affect existing members, and they will keep paying the same amount they were paying when they joined the tier."
                  variant="filled"
                  leftSection={<CurrencyIcon currency="BUZZ" size={16} />}
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
                <InputNumber
                  name="memberLimit"
                  label="Member limit"
                  description="If you want to make this an exclusive tier, you can set a limit on the number of members that can join it."
                  clearable
                  variant="filled"
                  max={constants.clubs.tierMaxMemberLimit}
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
                        <LegacyActionIcon
                          size="sm"
                          variant="filled"
                          color="red"
                          onClick={() =>
                            form.setValue('coverImage', clubTier?.coverImage?.id ? null : undefined)
                          }
                          style={{
                            position: 'absolute',
                            top: 'calc(--mantine-spacing-xs * 0.4)',
                            right: 'calc(--mantine-spacing-xs * 0.4)',
                            zIndex: 1,
                          }}
                        >
                          <IconTrash />
                        </LegacyActionIcon>
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
                    <Stack gap={4}>
                      <Group gap={4}>
                        <Text inline>Unlisted</Text>
                      </Group>
                      <Text size="xs" c="dimmed">
                        This tier will not be displayed to users directly, but they can join it if
                        they have the link.
                      </Text>
                    </Stack>
                  }
                />
                <InputSwitch
                  name="joinable"
                  label={
                    <Stack gap={4}>
                      <Group gap={4}>
                        <Text inline>Joinable</Text>
                      </Group>
                      <Text size="xs" c="dimmed">
                        This tier will not be joinable by users, regardless of whether they have a
                        link or not. This is useful to create tiers that are only available to users
                        you want to invite and to start working on a tier before other users get
                        access to it.
                      </Text>
                    </Stack>
                  }
                />
                <InputSwitch
                  name="oneTimeFee"
                  label={
                    <Stack gap={4}>
                      <Group gap={4}>
                        <Text inline>One time payment</Text>
                      </Group>
                      <Text size="xs" c="dimmed">
                        This tier will not be charged on a monthly basis and its users will only pay
                        the joining fee.
                      </Text>
                    </Stack>
                  }
                />
              </Stack>
            </Stack>
          </Grid.Col>
        </Grid>
        <Group justify="flex-end">
          {onCancel && (
            <Button
              loading={upsertingTier}
              onClick={(e: React.MouseEvent) => {
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
