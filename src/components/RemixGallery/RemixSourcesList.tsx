import { Button, Group, Text } from '@mantine/core';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { useAvailableBuzz } from '~/components/Buzz/useAvailableBuzz';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';

/**
 * Why a source cannot be submitted to.
 *
 * `unavailable` deliberately says nothing about WHY the host cannot be shown.
 * The host's moderation state is not the poster's business, and this surface
 * would otherwise turn any image id into a way to read it — the same reason the
 * submit mutation's refusals are anonymised.
 */
const reasonLabel: Record<string, string> = {
  own: 'Your own image',
  closed: 'Not available',
  submitted: 'Already submitted',
  unavailable: 'Not available',
};

/**
 * The galleries one of your own images could be submitted to.
 *
 * Every caller gates its own rendering on this being non-empty, which is why it
 * is a hook rather than a prop drilled down from one place: the answer is per
 * image and the flag check belongs with the query it suppresses.
 *
 * The flag check is not decoration. `submitToRemixGallery` refuses when the flag
 * is off, so without it the surface renders live buttons that fail on click, and
 * asks a protected query per image during rollout.
 */
export function useRemixSources(imageId: number) {
  const features = useFeatureFlags();
  const { data, isLoading } = trpc.placement.getRemixSourcesForImage.useQuery(
    { imageId },
    { enabled: !!features.remixGallery }
  );

  return { sources: data, isLoading, enabled: !!features.remixGallery };
}

/**
 * One row per gallery this image could go to: thumbnail, price, submit.
 *
 * Rendered by the post editor's card, by the feed's submit dialog and by the
 * generator's, so the money path has exactly one shape. A second copy of these
 * buttons is a second place for the free/paid rules to drift from what the
 * mutation refuses.
 */
export function RemixSourcesList({
  imageId,
  /** Only changes what the success message promises; both states submit here. */
  published,
  onSubmitted,
}: {
  imageId: number;
  published: boolean;
  onSubmitted?: () => void;
}) {
  const utils = trpc.useUtils();
  const spendTypes = useAvailableBuzz();
  const { sources } = useRemixSources(imageId);

  const submit = trpc.placement.submitToRemixGallery.useMutation({
    onSuccess: () => {
      // Re-read rather than patched in place: the row comes back as
      // `unavailable: 'submitted'`, the same state a submission made anywhere
      // else produces. Patching locally would invent a second route to it that
      // could drift from the server's.
      void utils.placement.getRemixSourcesForImage.invalidate({ imageId });
      showSuccessNotification({
        title: 'Remix submitted',
        message: published
          ? 'The creator will see it in their gallery queue.'
          : 'Publish your post to finalise it — the creator sees it once the image is live.',
      });
      onSubmitted?.();
    },
    onError: (error) =>
      showErrorNotification({ title: "Couldn't submit that", error: new Error(error.message) }),
  });

  // Keyed to the row, not the mutation. A bare `submit.isPending` spins every
  // button in the list on any one click — the same bug the manage modal's
  // per-row keying exists to avoid.
  const submitting = submit.isPending ? submit.variables?.hostImageId : undefined;

  if (!sources?.length) return null;

  return (
    <>
      {sources.map((source) => {
        const blocked = !!source.unavailable;

        return (
          <Group key={source.hostImageId} gap="sm" wrap="nowrap" align="flex-start">
            {/* Links out rather than opening the detail dialog: this can sit
                inside a post the poster is mid-way through editing, and a dialog
                over it invites them to navigate away from unsaved work. */}
            <Link
              href={`/images/${source.hostImageId}`}
              target="_blank"
              rel="noreferrer"
              className="shrink-0"
            >
              {source.image?.viewable ? (
                <EdgeMedia
                  src={source.image.url}
                  type="image"
                  width={64}
                  className="size-12 rounded object-cover"
                  alt=""
                />
              ) : (
                <div className="size-12 rounded bg-gray-3 dark:bg-dark-5" />
              )}
            </Link>

            <div className="flex min-w-0 flex-1 flex-col gap-1">
              {blocked ? (
                <Text size="xs" c="dimmed">
                  {reasonLabel[source.unavailable as string] ?? reasonLabel.unavailable}
                </Text>
              ) : (
                <>
                  <Text size="xs" c="dimmed" ta="center" className="leading-tight">
                    Get seen with this image
                  </Text>
                  {source.freeAvailable ? (
                    <Button
                      size="compact-sm"
                      variant="light"
                      color="green"
                      fullWidth
                      loading={submitting === source.hostImageId}
                      onClick={() =>
                        submit.mutate({ imageId, hostImageId: source.hostImageId, free: true })
                      }
                    >
                      Submit free
                    </Button>
                  ) : (
                    /* `BuzzTransactionButton`, not a plain one: it checks
                       affordability against the same number it displays, and is
                       what every other Buzz spend on the site uses. A plain
                       button here would be the one place we charge without that
                       check. */
                    <BuzzTransactionButton
                      buzzAmount={source.price ?? 0}
                      accountTypes={spendTypes}
                      label="Submit"
                      size="compact-sm"
                      // Matches the free button beside it. `BuzzTransactionButton`
                      // forwards unknown props to the underlying Mantine Button.
                      fullWidth
                      loading={submitting === source.hostImageId}
                      // The price this render displayed travels with it, so the
                      // server refuses rather than charging a number the poster
                      // never agreed to.
                      onPerformTransaction={() =>
                        submit.mutate({
                          imageId,
                          hostImageId: source.hostImageId,
                          expectedPrice: source.price ?? 0,
                        })
                      }
                    />
                  )}
                </>
              )}
            </div>
          </Group>
        );
      })}
    </>
  );
}
