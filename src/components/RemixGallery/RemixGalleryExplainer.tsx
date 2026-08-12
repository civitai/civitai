import { Anchor, CloseButton, Text } from '@mantine/core';
import { IconHierarchy } from '@tabler/icons-react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

const ALERT_ID = 'remix-gallery-explainer';

/** Where the reasoning lives in full, for anyone who wants it. */
const EARNINGS_ARTICLE =
  'https://civitai.com/articles/33568/how-image-creators-earn-what-we-heard-and-what-were-building';

/**
 * What the gallery is for, inside the gallery.
 *
 * Testers read the panel and asked what the point was and what counts as a
 * remix. The reasoning was already published, but nobody reads an article
 * before pressing a button, so it has to be where the feature is.
 *
 * Dismissal goes to user settings rather than `localStorage`, which is what
 * `DismissibleAlert` would have given us: this explains a feature, not a
 * one-off event, and someone who has read it should not meet it again on their
 * phone. Same pattern as {@link ../Alerts/NavTidyNotice}, down to the
 * optimistic update and the `!!settings` guard.
 */
export function RemixGalleryExplainer() {
  const currentUser = useCurrentUser();
  const utils = trpc.useUtils();

  const { data: settings } = trpc.user.getSettings.useQuery(undefined, {
    enabled: !!currentUser,
  });

  const dismiss = trpc.user.dismissAlert.useMutation({
    onMutate: async () => {
      await utils.user.getSettings.cancel();
      const prev = utils.user.getSettings.getData();
      utils.user.getSettings.setData(undefined, (old) => ({
        ...old,
        dismissedAlerts: [...(old?.dismissedAlerts ?? []), ALERT_ID],
      }));
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) utils.user.getSettings.setData(undefined, ctx.prev);
    },
    // The optimistic write spreads `...old`, so a cache seeded from a failed SSR
    // snapshot could persist a truncated settings object. One refetch per
    // dismiss, which is rare — not one per mount.
    onSettled: () => {
      utils.user.getSettings.invalidate();
    },
  });

  const isDismissed = (settings?.dismissedAlerts ?? []).includes(ALERT_ID);
  // Signed out there is nowhere to record a dismissal, so showing it would mean
  // showing it forever.
  if (!currentUser || !settings || isDismissed) return null;

  return (
    <div className="flex gap-2 rounded-md bg-blue-0 p-2 dark:bg-dark-6">
      <IconHierarchy size={16} className="mt-0.5 shrink-0 text-blue-6" />
      <div className="flex flex-col gap-1">
        <Text size="xs" fw={600}>
          What&apos;s a remix gallery?
        </Text>
        <Text size="xs" c="dimmed" lh={1.4}>
          Any creator can appear on a popular image, and you get to see other takes on work you
          liked. Iterate on it, restyle it, edit it, or turn it into a video — the creator reviews
          every submission.{' '}
          <Anchor href={EARNINGS_ARTICLE} target="_blank" rel="noreferrer" size="xs">
            Why we built this
          </Anchor>
        </Text>
      </div>
      <CloseButton
        size="xs"
        variant="subtle"
        color="gray"
        radius="xl"
        className="ml-auto shrink-0"
        aria-label="Dismiss"
        onClick={() => dismiss.mutate({ alertId: ALERT_ID })}
      />
    </div>
  );
}
