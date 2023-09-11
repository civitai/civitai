import { Button, Group, Stack, Title } from '@mantine/core';
import { getMinMaxDates, useQueryBounty } from '~/components/Bounty/bounty.utils';
import { Form, InputDatePicker, InputRTE, useForm, InputMultiFileUpload } from '~/libs/form';
import { UpdateBountyInput, updateBountyInputSchema } from '~/server/schema/bounty.schema';
import { BountyGetById } from '~/types/router';
import { BackButton } from '../BackButton/BackButton';
import { useRouter } from 'next/router';

export function BountyEditForm({ bounty }: Props) {
  const router = useRouter();

  const defaultValues = {
    id: bounty.id,
    description: bounty.description,
    startsAt: bounty.startsAt,
    expiresAt: bounty.expiresAt,
    files: bounty.files?.map((file) => ({ ...file, metadata: file.metadata as MixedObject })) ?? [],
  };
  const form = useForm({ schema: updateBountyInputSchema, defaultValues, shouldUnregister: false });

  const { updateBounty: update, updating } = useQueryBounty({ bountyId: bounty.id });

  const handleSubmit = async (data: UpdateBountyInput) => {
    await update(data);
    await router.push(`/bounties/${bounty.id}`);
  };

  const alreadyStarted = bounty.startsAt < new Date();
  const { minStartDate, maxStartDate, minExpiresDate, maxExpiresDate } = getMinMaxDates();

  return (
    <Form form={form} onSubmit={handleSubmit}>
      <Stack spacing="xl">
        <Group spacing={4}>
          <BackButton url={`/bounties/${bounty.id}`} />
          <Title>Editing {bounty.name} Bounty</Title>
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
          <Group spacing="xs" grow>
            <InputDatePicker
              name="startsAt"
              label="Start Date"
              placeholder="Select a starts date"
              withAsterisk
              minDate={minStartDate}
              maxDate={maxStartDate}
            />
            <InputDatePicker
              name="expiresAt"
              label="Expiration Date"
              placeholder="Select an end date"
              withAsterisk
              minDate={minExpiresDate}
              maxDate={maxExpiresDate}
            />
          </Group>
        )}
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
        />
        <Group position="right">
          <Button type="submit" disabled={updating}>
            Save
          </Button>
        </Group>
      </Stack>
    </Form>
  );
}

type Props = { bounty: BountyGetById };
