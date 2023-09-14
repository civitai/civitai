import {
  Button,
  Group,
  Stack,
  Title,
  ActionIcon,
  Text,
  Tooltip,
  Anchor,
  createStyles,
} from '@mantine/core';
import { TagTarget } from '@prisma/client';
import { IconCalendarDue, IconTrash } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { getMinMaxDates, useMutateBounty } from '~/components/Bounty/bounty.utils';
import {
  Form,
  InputDatePicker,
  InputRTE,
  useForm,
  InputMultiFileUpload,
  InputTags,
} from '~/libs/form';
import { UpdateBountyInput, updateBountyInputSchema } from '~/server/schema/bounty.schema';
import { BountyGetById } from '~/types/router';
import { BackButton } from '../BackButton/BackButton';
import { IconCalendar } from '@tabler/icons-react';

const useStyles = createStyles((theme) => ({
  title: {
    [theme.fn.smallerThan('sm')]: {
      fontSize: '24px',
    },
  },
  fluid: {
    maxWidth: '100% !important',
  },
}));

export function BountyEditForm({ bounty }: Props) {
  const router = useRouter();
  const { classes } = useStyles();

  const defaultValues = {
    ...bounty,
    id: bounty.id,
    description: bounty.description,
    startsAt: bounty.startsAt,
    expiresAt: bounty.expiresAt,
    files: bounty.files?.map((file) => ({ ...file, metadata: file.metadata as MixedObject })) ?? [],
  };
  const form = useForm({ schema: updateBountyInputSchema, defaultValues, shouldUnregister: false });

  const { updateBounty: update, updating } = useMutateBounty({ bountyId: bounty.id });

  const handleSubmit = async (data: UpdateBountyInput) => {
    await update(data);
    await router.push(`/bounties/${bounty.id}`);
  };

  const alreadyStarted = bounty.startsAt < new Date();
  const { minStartDate, maxStartDate, minExpiresDate, maxExpiresDate } = getMinMaxDates();

  return (
    <Form form={form} onSubmit={handleSubmit}>
      <Stack spacing="xl">
        <Group spacing="md" noWrap>
          <BackButton url={`/bounties/${bounty.id}`} />
          <Title className={classes.title}>Editing {bounty.name} Bounty</Title>
        </Group>
        <InputRTE
          name="description"
          label="Description"
          editorSize="xl"
          includeControls={['heading', 'formatting', 'list', 'link', 'media', 'polls', 'colors']}
          withAsterisk
          stickyToolbar
        />
        {!alreadyStarted && (
          <Group spacing="xl" grow>
            <InputDatePicker
              className={classes.fluid}
              name="startsAt"
              label="Start Date"
              placeholder="Select a starts date"
              icon={<IconCalendar size={16} />}
              withAsterisk
              minDate={minStartDate}
              maxDate={maxStartDate}
            />
            <InputDatePicker
              className={classes.fluid}
              name="expiresAt"
              label="Deadline"
              placeholder="Select an end date"
              icon={<IconCalendarDue size={16} />}
              withAsterisk
              minDate={minExpiresDate}
              maxDate={maxExpiresDate}
            />
          </Group>
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
              'text/markdown': ['.md'],
              'text/x-python-script': ['.py'],
            },
          }}
          renderItem={(file, onRemove) => (
            <>
              {file.id ? (
                <Anchor
                  href={`/api/download/attachments/${file.id}`}
                  size="sm"
                  weight={500}
                  lineClamp={1}
                  download
                >
                  {file.name}
                </Anchor>
              ) : (
                <Text size="sm" weight={500} lineClamp={1}>
                  {file.name}
                </Text>
              )}
              {!file.id && (
                <Tooltip label="Remove">
                  <ActionIcon
                    size="sm"
                    color="red"
                    variant="transparent"
                    onClick={() => onRemove()}
                  >
                    <IconTrash />
                  </ActionIcon>
                </Tooltip>
              )}
            </>
          )}
        />
        <Group position="right">
          <Button type="submit" loading={updating}>
            Save
          </Button>
        </Group>
      </Stack>
    </Form>
  );
}

type Props = { bounty: BountyGetById };
