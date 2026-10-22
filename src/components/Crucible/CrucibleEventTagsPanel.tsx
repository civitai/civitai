import { Loader, Paper, TagsInput, Text, Title } from '@mantine/core';
import { IconTags } from '@tabler/icons-react';
import { crucibleEventTagSchema } from '~/server/schema/crucible.schema';
import { CRUCIBLE_MAX_EVENT_TAGS } from '~/shared/constants/crucible.constants';
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

  const handleChange = (values: string[]) => {
    const parsed = values.map((value) => crucibleEventTagSchema.safeParse(value));
    const invalid = values.filter((_, i) => !parsed[i].success);
    if (invalid.length) {
      showErrorNotification({
        title: 'Invalid event tag',
        error: new Error(`Use letters, numbers and dashes: ${invalid.join(', ')}`),
      });
      return;
    }
    const eventTags = parsed.flatMap((result) => (result.success ? [result.data] : []));
    setEventTags.mutate({ id: crucibleId, eventTags: [...new Set(eventTags)] });
  };

  return (
    <Paper className="rounded-lg p-6" bg="dark.6">
      <Title order={5} className="mb-4 flex items-center gap-2 uppercase tracking-wider text-white">
        <IconTags size={16} />
        Event Tags
      </Title>
      <TagsInput
        aria-label="Event tags"
        placeholder="Add tag..."
        value={eventTags}
        onChange={handleChange}
        maxTags={CRUCIBLE_MAX_EVENT_TAGS}
        splitChars={[',', ' ']}
        acceptValueOnBlur
        disabled={isLoading || setEventTags.isPending}
        rightSection={setEventTags.isPending ? <Loader size="xs" /> : undefined}
      />
      <Text size="xs" c="dimmed" mt="sm">
        Only moderators see these. A homepage Feed block set to an event tag lists the running and
        upcoming crucibles that carry it.
      </Text>
    </Paper>
  );
}
