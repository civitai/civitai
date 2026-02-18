import { Button, Group, Loader, Modal, Select, Stack } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconPlus } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import * as z from 'zod';
import { Form, InputJson, InputText, InputTextArea, useForm } from '~/libs/form';
import { upsertJudgeSchema } from '~/server/schema/challenge.schema';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { usePlaygroundStore } from './playground.store';
import { TemplateVariableIndicators } from './TemplateVariableIndicators';

// Form schema — derives from server schema, overrides userId to string for Select
const schema = upsertJudgeSchema.omit({ id: true, userId: true, active: true }).extend({
  userId: z.string().nullish().default(null),
});

const defaultValues: z.infer<typeof schema> = {
  name: '',
  userId: null,
  bio: null,
  sourceCollectionId: null,
  systemPrompt: null,
  collectionPrompt: null,
  contentPrompt: null,
  reviewPrompt: null,
  reviewTemplate: null,
  winnerSelectionPrompt: null,
};

export function CreateJudgeModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const setSelectedJudgeId = usePlaygroundStore((s) => s.setSelectedJudgeId);

  const form = useForm({ schema, defaultValues });

  // User search state (external to form — drives the async Select)
  const [userSearch, setUserSearch] = useState('');
  const [debouncedSearch] = useDebouncedValue(userSearch, 300);

  const { data: usersData, isLoading: usersLoading } = trpc.user.getAll.useQuery(
    { query: debouncedSearch, limit: 20 },
    { enabled: debouncedSearch.length >= 2 }
  );

  const userOptions = useMemo(
    () =>
      (usersData ?? []).map((u) => ({
        value: String(u.id),
        label: u.username ?? `User ${u.id}`,
      })),
    [usersData]
  );

  const queryUtils = trpc.useUtils();
  const upsertMutation = trpc.challenge.upsertJudge.useMutation({
    onSuccess: (data) => {
      showSuccessNotification({ message: 'Judge created' });
      queryUtils.challenge.getJudges.invalidate();
      setSelectedJudgeId(data.id);
      resetAndClose();
    },
    onError: (error) => {
      showErrorNotification({ error: new Error(error.message) });
    },
  });

  const resetAndClose = () => {
    form.reset(defaultValues);
    setUserSearch('');
    onClose();
  };

  const handleSubmit = (data: z.infer<typeof schema>) => {
    upsertMutation.mutate({
      name: data.name,
      userId: data.userId ? parseInt(data.userId, 10) : undefined,
      bio: data.bio,
      systemPrompt: data.systemPrompt,
      contentPrompt: data.contentPrompt,
      reviewPrompt: data.reviewPrompt,
      reviewTemplate: data.reviewTemplate,
      winnerSelectionPrompt: data.winnerSelectionPrompt,
    });
  };

  const nothingFoundMessage = usersLoading
    ? 'Searching...'
    : debouncedSearch.length < 2
    ? 'Type at least 2 characters'
    : 'No users found';

  return (
    <Modal opened={opened} onClose={resetAndClose} title="Create Judge" size="lg">
      <Form form={form} onSubmit={handleSubmit}>
        <Stack gap="sm">
          <Select
            label="User"
            description="Search for a user to associate with this judge"
            placeholder="Type a username..."
            data={userOptions}
            value={form.watch('userId')}
            onChange={(v) => form.setValue('userId', v)}
            searchable
            searchValue={userSearch}
            onSearchChange={setUserSearch}
            nothingFoundMessage={nothingFoundMessage}
            rightSection={usersLoading ? <Loader size="xs" /> : undefined}
            clearable
          />
          <InputText name="name" label="Name" withAsterisk />
          <InputTextArea name="bio" label="Bio" autosize minRows={2} maxRows={4} />
          <InputTextArea
            name="systemPrompt"
            label="System Prompt"
            autosize
            minRows={3}
            maxRows={8}
          />
          <InputTextArea
            name="contentPrompt"
            label="Content Prompt"
            description="Used for challenge content generation"
            autosize
            minRows={3}
            maxRows={8}
          />
          <InputTextArea
            name="reviewPrompt"
            label="Review Prompt"
            description="Used for image review scoring"
            autosize
            minRows={3}
            maxRows={8}
          />
          <InputJson
            name="reviewTemplate"
            label="Review Template (JSON)"
            description={<TemplateVariableIndicators value={form.watch('reviewTemplate') ?? ''} />}
            autosize
            minRows={3}
            maxRows={8}
            formatOnBlur
            validationError="Invalid JSON"
            styles={{ input: { fontFamily: 'monospace', fontSize: '12px' } }}
          />
          <InputTextArea
            name="winnerSelectionPrompt"
            label="Winner Selection Prompt"
            description="Used for picking challenge winners"
            autosize
            minRows={3}
            maxRows={8}
          />
          <Group justify="flex-end" mt="sm">
            <Button variant="default" onClick={resetAndClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              leftSection={<IconPlus size={16} />}
              loading={upsertMutation.isPending}
            >
              Create Judge
            </Button>
          </Group>
        </Stack>
      </Form>
    </Modal>
  );
}
