import { Paper, Text, Title } from '@mantine/core';
import { IconTags } from '@tabler/icons-react';
import { EventTagsInput } from '~/components/EventTags/EventTagsInput';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/** Moderators only. Tags put the crucible in any homepage Feed block that lists that tag. */
export function CrucibleEventTagsPanel({ crucibleId }: { crucibleId: number }) {
  const utils = trpc.useUtils();
  const { data: eventTags = [], isLoading } = trpc.crucible.getEventTags.useQuery({
    id: crucibleId,
  });
  const setEventTags = trpc.crucible.setEventTags.useMutation({
    onSuccess: (saved) => utils.crucible.getEventTags.setData({ id: crucibleId }, saved),
    onError: (error) =>
      showErrorNotification({
        title: 'Could not save event tags',
        error: new Error(error.message),
      }),
  });

  return (
    <Paper className="rounded-lg p-6" bg="dark.6">
      <Title order={5} className="mb-4 flex items-center gap-2 uppercase tracking-wider text-white">
        <IconTags size={16} />
        Event Tags
      </Title>
      <EventTagsInput
        value={eventTags}
        onChange={(next) => setEventTags.mutate({ id: crucibleId, eventTags: next })}
        loading={setEventTags.isPending}
        disabled={isLoading}
      />
      <Text size="xs" c="dimmed" mt="sm">
        Only moderators see these. A homepage Feed block set to an event tag lists the running and
        upcoming crucibles that carry it.
      </Text>
    </Paper>
  );
}
