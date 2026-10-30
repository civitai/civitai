import { Anchor, CloseButton, Text } from '@mantine/core';
import { IconHierarchy } from '@tabler/icons-react';
import { FEATURE_NOTICES } from '~/components/Alerts/notice-registry';
import { useFeatureNotice } from '~/components/Alerts/useFeatureNotice';
import { useCurrentUser } from '~/hooks/useCurrentUser';

/**
 * Where the reasoning lives in full, for anyone who wants it.
 *
 * Relative, so a reader on civitai.red stays on civitai.red. An absolute
 * civitai.com URL would move them off the domain they chose.
 */
const EARNINGS_ARTICLE =
  '/articles/33568/how-image-creators-earn-what-we-heard-and-what-were-building';

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
 * phone. Same pattern as {@link ../Alerts/NavCustomizeNotice}, down to the
 * optimistic update and the resolved-settings guard.
 *
 * 🔴 The first site to consume a notice `audience`. The registry marks this
 * notice as announcing the `remixGallery` rollout, so `isInAudience` is the
 * per-user answer to that flag and is ANDed into the render condition below.
 * Its parent gates on the same flag, so this does not narrow who sees it today
 * — it makes the notice carry its own gate, so a future mount site cannot show
 * an announcement to someone who does not have the thing being announced.
 */
export function RemixGalleryExplainer() {
  const currentUser = useCurrentUser();
  const { isDismissed, hasSettings, isInAudience, dismiss } = useFeatureNotice(
    FEATURE_NOTICES.remixGalleryExplainer
  );

  // Signed out there is nowhere to record a dismissal, so showing it would mean
  // showing it forever. `hasSettings` (not `isLoading`) is what proves a
  // settings object resolved, so an errored fetch cannot flash this at someone
  // who already dismissed it.
  if (!currentUser || !hasSettings || isDismissed || !isInAudience) return null;

  return (
    <div className="flex gap-2 rounded-md border border-blue-2 bg-blue-0 p-2 dark:border-blue-9/30 dark:bg-blue-9/20">
      <IconHierarchy size={16} className="mt-0.5 shrink-0 text-blue-6 dark:text-blue-4" />
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
        onClick={() => dismiss()}
      />
    </div>
  );
}
