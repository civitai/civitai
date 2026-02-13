import {
  Button,
  Group,
  Loader,
  Modal,
  Select,
  Stack,
  TextInput,
  Textarea,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconPlus } from '@tabler/icons-react';
import { useState } from 'react';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { usePlaygroundStore } from './playground.store';

export function CreateJudgeModal({
  opened,
  onClose,
}: {
  opened: boolean;
  onClose: () => void;
}) {
  const setSelectedJudgeId = usePlaygroundStore((s) => s.setSelectedJudgeId);

  const [name, setName] = useState('');
  const [bio, setBio] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [contentPrompt, setContentPrompt] = useState('');
  const [reviewPrompt, setReviewPrompt] = useState('');
  const [winnerSelectionPrompt, setWinnerSelectionPrompt] = useState('');
  const [userSearch, setUserSearch] = useState('');
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  const [debouncedSearch] = useDebouncedValue(userSearch, 300);

  const { data: usersData, isLoading: usersLoading } = trpc.user.getAll.useQuery(
    { query: debouncedSearch, limit: 20 },
    { enabled: debouncedSearch.length >= 2 }
  );

  const userOptions = (usersData ?? []).map((u) => ({
    value: String(u.id),
    label: u.username ?? `User ${u.id}`,
  }));

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
    setName('');
    setBio('');
    setSystemPrompt('');
    setContentPrompt('');
    setReviewPrompt('');
    setWinnerSelectionPrompt('');
    setUserSearch('');
    setSelectedUserId(null);
    onClose();
  };

  const handleCreate = () => {
    upsertMutation.mutate({
      name,
      userId: selectedUserId ? parseInt(selectedUserId, 10) : undefined,
      bio: bio || null,
      systemPrompt: systemPrompt || null,
      contentPrompt: contentPrompt || null,
      reviewPrompt: reviewPrompt || null,
      winnerSelectionPrompt: winnerSelectionPrompt || null,
    });
  };

  return (
    <Modal opened={opened} onClose={resetAndClose} title="Create Judge" size="lg">
      <Stack gap="sm">
        <Select
          label="User"
          description="Search for a user to associate with this judge"
          placeholder="Type a username..."
          data={userOptions}
          value={selectedUserId}
          onChange={setSelectedUserId}
          searchable
          searchValue={userSearch}
          onSearchChange={setUserSearch}
          nothingFoundMessage={
            usersLoading
              ? 'Searching...'
              : debouncedSearch.length < 2
                ? 'Type at least 2 characters'
                : 'No users found'
          }
          rightSection={usersLoading ? <Loader size="xs" /> : undefined}
          clearable
        />
        <TextInput label="Name" required value={name} onChange={(e) => setName(e.currentTarget.value)} />
        <Textarea
          label="Bio"
          autosize
          minRows={2}
          maxRows={4}
          value={bio}
          onChange={(e) => setBio(e.currentTarget.value)}
        />
        <Textarea
          label="System Prompt"
          autosize
          minRows={3}
          maxRows={8}
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.currentTarget.value)}
        />
        <Textarea
          label="Content Prompt"
          description="Used for challenge content generation"
          autosize
          minRows={3}
          maxRows={8}
          value={contentPrompt}
          onChange={(e) => setContentPrompt(e.currentTarget.value)}
        />
        <Textarea
          label="Review Prompt"
          description="Used for image review scoring"
          autosize
          minRows={3}
          maxRows={8}
          value={reviewPrompt}
          onChange={(e) => setReviewPrompt(e.currentTarget.value)}
        />
        <Textarea
          label="Winner Selection Prompt"
          description="Used for picking challenge winners"
          autosize
          minRows={3}
          maxRows={8}
          value={winnerSelectionPrompt}
          onChange={(e) => setWinnerSelectionPrompt(e.currentTarget.value)}
        />
        <Group justify="flex-end" mt="sm">
          <Button variant="default" onClick={resetAndClose}>
            Cancel
          </Button>
          <Button
            leftSection={<IconPlus size={16} />}
            onClick={handleCreate}
            loading={upsertMutation.isLoading}
            disabled={!name}
          >
            Create Judge
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
