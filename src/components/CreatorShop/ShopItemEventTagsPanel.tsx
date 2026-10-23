import { Stack, Text } from '@mantine/core';
import { EventTagsInput } from '~/components/EventTags/EventTagsInput';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/** Offered as one click in the review drawer, for the event running now. */
const QUICK_EVENT_TAGS = ['halloween'];

/**
 * Moderators only. An event tag puts a published item in every shop section with that tag, and so
 * on any homepage block showing one, without placing it by hand.
 */
export function ShopItemEventTagsPanel({ shopItemId }: { shopItemId: number }) {
  const utils = trpc.useUtils();
  const { data: eventTags = [], isLoading } = trpc.cosmeticShop.getShopItemEventTags.useQuery({
    shopItemId,
  });
  const setEventTags = trpc.cosmeticShop.setShopItemEventTags.useMutation({
    onSuccess: (saved) => utils.cosmeticShop.getShopItemEventTags.setData({ shopItemId }, saved),
    onError: (error) =>
      showErrorNotification({
        title: 'Could not save event tags',
        error: new Error(error.message),
      }),
  });

  return (
    <Stack gap={8}>
      <Text size="sm" fw={600}>
        Event tags
      </Text>
      <div>
        <EventTagsInput
          value={eventTags}
          onChange={(next) => setEventTags.mutate({ shopItemId, eventTags: next })}
          loading={setEventTags.isPending}
          disabled={isLoading}
          quickTags={QUICK_EVENT_TAGS}
        />
      </div>
      <Text size="xs" c="dimmed">
        Once published, a tagged item shows in every shop section with the same event tag, and on
        the homepage blocks that show those sections.
      </Text>
    </Stack>
  );
}
