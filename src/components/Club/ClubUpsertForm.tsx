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

const tooltipProps: Partial<TooltipProps> = {
  maw: 300,
  multiline: true,
  position: 'bottom',
  withArrow: true,
};

const formSchema = upsertClubInput;

const useStyles = createStyles((theme) => ({
  radioItemWrapper: {
    '& .mantine-Group-root': {
      alignItems: 'stretch',
      [theme.fn.smallerThan('sm')]: {
        flexDirection: 'column',
      },
    },
  },

  radioItem: {
    border: `1px solid ${
      theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[4]
    }`,
    borderRadius: theme.radius.sm,
    padding: theme.spacing.xs,
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.white,
    display: 'flex',
    flex: 1,

    '& > .mantine-Radio-body, & .mantine-Radio-label': {
      width: '100%',
    },

    '& > .mantine-Switch-body, & .mantine-Switch-labelWrapper, & .mantine-Switch-label': {
      width: '100%',
    },
  },

  root: {
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.white,
  },
  label: {
    textTransform: 'capitalize',
  },
  active: {
    border: `2px solid ${theme.colors.blue[5]}`,
    backgroundColor: 'transparent',
  },

  title: {
    [theme.fn.smallerThan('sm')]: {
      fontSize: '24px',
    },
  },
  sectionTitle: {
    [theme.fn.smallerThan('sm')]: {
      fontSize: '18px',
    },
  },
  fluid: {
    [theme.fn.smallerThan('sm')]: {
      maxWidth: '100% !important',
    },
  },
  stickySidebar: {
    position: 'sticky',
    top: `calc(var(--mantine-header-height) + ${theme.spacing.md}px)`,

    [theme.fn.smallerThan('md')]: {
      position: 'relative',
      top: 0,
    },
  },
}));

export function ClubUpsertForm({ club }: { club?: MixedObject }) {
  const router = useRouter();
  const { classes } = useStyles();

  const form = useForm({
    schema: formSchema,
    // defaultValues: {
    // }
    shouldUnregister: false,
  });

  const [avatarImage] = form.watch(['avatarImage']);

  const { upsertClub, upserting } = useMutateClub({ clubId: club?.id as number | undefined });
  const handleSubmit = async (data: z.infer<typeof formSchema>) => {
    try {
      const result = await upsertClub({
        ...data,
      });

      await router.push(`/clubs/${result?.id}`);
    } catch (error) {
      // Do nothing since the query event will show an error notification
    }
  };

  return (
    <Form form={form} onSubmit={handleSubmit}>
      <Stack spacing={32}>
        <Group spacing="md" noWrap>
          <BackButton url="/bounties" />
          <Title className={classes.title}>
            {club ? `Editing ${club.name}` : 'Create a new club'}
          </Title>
        </Group>
        <Grid gutter="xl">
          <Grid.Col xs={12}>
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
                <Group grow>
                  {avatarImage && (
                    <div style={{ position: 'relative', width: 124, flexGrow: 0 }}>
                      <Avatar
                        src={getEdgeUrl(avatarImage?.url, { transcode: false })}
                        size={124}
                        radius="sm"
                      />
                      <Tooltip label="Remove image">
                        <ActionIcon
                          size="sm"
                          variant="filled"
                          color="red"
                          onClick={() =>
                            form.setValue('avatarImage', club?.avatar?.id ? null : undefined)
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
                    name="avatarImage"
                    label="Profile Image"
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
                  description={`Suggested resolution: ${constants.profile.coverImageWidth}x${constants.profile.coverImageHeight}px`}
                  aspectRatio={constants.profile.coverImageAspectRatio}
                  // Im aware ideally this should ideally be 450, but images will look better on a higher res here
                  previewWidth={constants.profile.coverImageWidth}
                />
                <InputSwitch
                  name="nsfw"
                  label={
                    <Stack spacing={4}>
                      <Group spacing={4}>
                        <Text inline>Mature theme</Text>
                        <Tooltip label={matureLabel} {...tooltipProps}>
                          <ThemeIcon radius="xl" size="xs" color="gray">
                            <IconQuestionMark />
                          </ThemeIcon>
                        </Tooltip>
                      </Group>
                      <Text size="xs" color="dimmed">
                        This bounty is intended to produce mature content.
                      </Text>
                    </Stack>
                  }
                />
              </Stack>
            </Stack>
          </Grid.Col>
        </Grid>
        <Group position="right">
          <NavigateBack url="/clubs">
            {({ onClick }) => (
              <Button variant="light" color="gray" onClick={onClick}>
                Discard Changes
              </Button>
            )}
          </NavigateBack>
          <Button loading={upserting} type="submit">
            Save
          </Button>
        </Group>
      </Stack>
    </Form>
  );
}
