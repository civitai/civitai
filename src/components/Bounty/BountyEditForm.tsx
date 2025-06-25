import { ActionIcon, Anchor, Button, Group, Stack, Text, Title, Tooltip } from '@mantine/core';
import { TagTarget } from '~/shared/utils/prisma/enums';
import { IconCalendar, IconCalendarDue, IconTrash } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import React from 'react';
import { getMinMaxDates, useMutateBounty } from '~/components/Bounty/bounty.utils';
import {
  Form,
  InputCheckbox,
  InputDatePicker,
  InputMultiFileUpload,
  InputRTE,
  InputTags,
  useForm,
} from '~/libs/form';
import type { UpdateBountyInput } from '~/server/schema/bounty.schema';
import { updateBountyInputSchema } from '~/server/schema/bounty.schema';
import type { BountyGetById } from '~/types/router';
import { BackButton } from '../BackButton/BackButton';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { stripTime } from '~/utils/date-helpers';
import classes from './BountyEditForm.module.scss';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

const schema = updateBountyInputSchema
  .refine((data) => data.startsAt < data.expiresAt, {
    message: 'Start date must be before expiration date',
    path: ['startsAt'],
  })
  .refine((data) => data.expiresAt > data.startsAt, {
    message: 'Expiration date must be after start date',
    path: ['expiresAt'],
  });

export function BountyEditForm({ bounty }: Props) {
  const router = useRouter();

  const defaultValues = {
    ...bounty,
    id: bounty.id,
    description: bounty.description,
    // TODO.bounty: fix date issue not using utc properly
    startsAt: bounty.startsAt,
    expiresAt: bounty.expiresAt,
    files: bounty.files?.map((file) => ({ ...file, metadata: file.metadata as MixedObject })) ?? [],
    ownRights:
      bounty.files?.length > 0 && bounty.files.every((f) => f.metadata?.ownRights === true),
  };
  const form = useForm({ schema, defaultValues, shouldUnregister: false });

  const files = form.watch('files');

  const { updateBounty: update, updating } = useMutateBounty({ bountyId: bounty.id });

  const handleSubmit = async (data: UpdateBountyInput) => {
    await update(data);
    await router.push(`/bounties/${bounty.id}`);
  };

  const alreadyStarted = bounty.startsAt < new Date();
  const { minStartDate, maxStartDate, minExpiresDate, maxExpiresDate } = getMinMaxDates();
  const expiresAt = form.watch('expiresAt');

  return (
    <Form form={form} onSubmit={handleSubmit}>
      <Stack gap="xl">
        <Group gap="md" wrap="nowrap">
          <BackButton url={`/bounties/${bounty.id}`} />
          <Title className={classes.title}>Editing {bounty.name} Bounty</Title>
        </Group>
        <InputRTE
          name="description"
          label="Description"
          editorSize="xl"
          includeControls={['heading', 'formatting', 'list', 'link', 'media', 'colors']}
          withAsterisk
          stickyToolbar
        />
        {!alreadyStarted && (
          <Stack>
            <Group gap="xl" grow>
              <InputDatePicker
                className={classes.fluid}
                name="startsAt"
                label="Start Date"
                placeholder="Select a starts date"
                leftSection={<IconCalendar size={16} />}
                withAsterisk
                minDate={minStartDate}
                maxDate={maxStartDate}
              />
              <InputDatePicker
                className={classes.fluid}
                name="expiresAt"
                label="Deadline"
                placeholder="Select an end date"
                leftSection={<IconCalendarDue size={16} />}
                withAsterisk
                minDate={minExpiresDate}
                maxDate={maxExpiresDate}
              />
            </Group>
            <Text fw={590}>
              With the selected dates, your bounty will expire{' '}
              <Text fw="bold" c="red.5" span>
                <DaysFromNow date={stripTime(expiresAt)} inUtc />
              </Text>
              . All times are in{' '}
              <Text fw="bold" c="red.5" span>
                UTC
              </Text>
              .
            </Text>
          </Stack>
        )}
        <InputTags name="tags" label="Tags" target={[TagTarget.Bounty]} />
        <InputMultiFileUpload
          name="files"
          label="Attachments"
          dropzoneProps={{
            maxSize: 100 * 1024 ** 2, // 100MB
            maxFiles: 10,
            // TODO.bounty: revise accepted file types
            accept: {
              'application/pdf': ['.pdf'],
              'application/zip': ['.zip'],
              'application/json': ['.json'],
              'application/x-yaml': ['.yaml', '.yml'],
              'text/plain': ['.txt'],
            },
          }}
          renderItem={(file, onRemove) => (
            <>
              {file.id ? (
                <Anchor
                  href={`/api/download/attachments/${file.id}`}
                  size="sm"
                  fw={500}
                  lineClamp={1}
                  download
                >
                  {file.name}
                </Anchor>
              ) : (
                <Text size="sm" fw={500} lineClamp={1}>
                  {file.name}
                </Text>
              )}
              {/* TODO we should probably allow users to remove existing files here */}
              {!file.id && (
                <Tooltip label="Remove">
                  <LegacyActionIcon
                    size="sm"
                    color="red"
                    variant="transparent"
                    onClick={() => onRemove()}
                  >
                    <IconTrash />
                  </LegacyActionIcon>
                </Tooltip>
              )}
            </>
          )}
        />
        {files && files.length > 0 && (
          <InputCheckbox name="ownRights" label="I own the rights to these files" mt="xs" />
        )}
        <Group justify="flex-end">
          <Button type="submit" loading={updating}>
            Save
          </Button>
        </Group>
      </Stack>
    </Form>
  );
}

type Props = { bounty: BountyGetById };
