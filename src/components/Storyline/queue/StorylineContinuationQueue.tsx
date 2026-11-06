import { Alert, Group, Loader, Tabs, Text } from '@mantine/core';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { StorylineSentList } from '~/components/Storyline/queue/StorylineSentList';
import {
  StorylineQueueList,
  type StorylineQueueAction,
  type StorylineQueueRow,
} from '~/components/Storyline/queue/StorylineQueueList';
import {
  useActOnStorylineContinuation,
  useStorylineQueue,
} from '~/components/Storyline/storyline.data';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const successCopy: Record<StorylineQueueAction, { title: string; message: string }> = {
  accept: { title: 'Accepted', message: "It's in your storyline now." },
  endorse: {
    title: 'Accepted and endorsed',
    message: 'Their future continuations skip review.',
  },
  decline: { title: 'Declined', message: "It won't appear in your storyline." },
};

const TABS = ['received', 'sent'] as const;
type TabValue = (typeof TABS)[number];
const isTabValue = (value: unknown): value is TabValue => TABS.includes(value as TabValue);

/** Both directions: what waits on your storylines, and what you have sent to other people's. */
export function StorylineContinuationQueue() {
  const router = useRouter();
  const tab: TabValue = isTabValue(router.query.tab) ? router.query.tab : 'received';
  const setTab = (value: string | null) =>
    router.replace(
      { query: { ...router.query, tab: isTabValue(value) ? value : 'received' } },
      undefined,
      { shallow: true }
    );

  return (
    <Tabs value={tab} onChange={setTab} keepMounted={false}>
      <Tabs.List>
        <Tabs.Tab value="received">Received</Tabs.Tab>
        <Tabs.Tab value="sent">Sent</Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="received" pt="md">
        <StorylineReceivedQueue />
      </Tabs.Panel>
      <Tabs.Panel value="sent" pt="md">
        <StorylineSentList />
      </Tabs.Panel>
    </Tabs>
  );
}

function StorylineReceivedQueue() {
  const utils = trpc.useUtils();
  const queue = useStorylineQueue({ enabled: true });
  const { act } = useActOnStorylineContinuation();
  const addCollaborator = trpc.storyline.addCollaborator.useMutation();
  const [busy, setBusy] = useState<{ id: number; action: StorylineQueueAction } | null>(null);

  const onAct = async (row: StorylineQueueRow, action: StorylineQueueAction) => {
    setBusy({ id: row.id, action });
    try {
      await act({ placementId: row.id, action: action === 'decline' ? 'decline' : 'approve' });
      // Endorsing is a collaborator write, not a placement decision. If it fails the
      // continuation is still accepted, and the creator is told which half did not happen.
      if (action === 'endorse' && row.placer) {
        try {
          await addCollaborator.mutateAsync({
            storylineId: row.storyline.id,
            userId: row.placer.id,
          });
        } catch (error) {
          showErrorNotification({
            title: 'Accepted, but not endorsed',
            error: error instanceof Error ? error : new Error(String(error)),
          });
          return;
        }
      }
      showSuccessNotification(successCopy[action]);
    } catch (error) {
      showErrorNotification({
        title: "Couldn't do that",
        error: error instanceof Error ? error : new Error(String(error)),
      });
    } finally {
      setBusy(null);
      await Promise.all([
        utils.placement.getPendingStorylineContinuations.invalidate(),
        utils.storyline.getById.invalidate({ id: row.storyline.id }),
      ]);
    }
  };

  if (queue.unavailable)
    return (
      <Alert color="gray">
        <Text size="sm">Reviewing storyline continuations is not available yet.</Text>
      </Alert>
    );

  if (queue.isLoading)
    return (
      <Group justify="center" py="xl">
        <Loader />
      </Group>
    );

  if (queue.isError)
    return (
      <Alert color="red">
        <Text size="sm">Couldn&rsquo;t load your review queue. Refresh to try again.</Text>
      </Alert>
    );

  return (
    <StorylineQueueList
      rows={queue.rows}
      hasMore={queue.hasMore}
      isFetchingMore={queue.isFetchingMore}
      onLoadMore={queue.loadMore}
      onAct={onAct}
      busy={busy}
    />
  );
}
