import { Button, Group, Text } from '@mantine/core';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { useAvailableBuzz } from '~/components/Buzz/useAvailableBuzz';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { CustomCard } from '~/components/Post/EditV2/PostImageCards/CustomCard';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
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
 * The galleries this image could be submitted to, in the post editor's image
 * card, directly under the image.
 *
 * Renders nothing when the image has no remix provenance, which is the ordinary
 * case: 0.2% of on-site generations carried any (measured 2026-08-27). A card
 * that always drew a header would sit empty on almost every post.
 */
export function RemixSourcesCard({
  imageId,
  /**
   * A published post has nothing left to hook a promise to — the image is
   * already live, so submitting is something to DO now rather than something to
   * schedule. Each source gets a button instead of a checkbox, and the publish
   * handler never sees these at all.
   */
  published,
}: {
  imageId: number;
  published: boolean;
}) {
  const utils = trpc.useUtils();
  const spendTypes = useAvailableBuzz();
  const { data, isLoading } = trpc.placement.getRemixSourcesForImage.useQuery({ imageId });

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
    },
    onError: (error) =>
      showErrorNotification({ title: "Couldn't submit that", error: new Error(error.message) }),
  });

  // Keyed to the row, not the mutation. A bare `submit.isPending` spins every
  // button in the list on any one click — the same bug the manage modal's
  // per-row keying exists to avoid.
  const submitting = submit.isPending ? submit.variables?.hostImageId : undefined;

  if (isLoading) return null;
  if (!data?.length) return null;

  return (
    <CustomCard className="flex flex-col gap-2">
      <h3 className="text-lg font-semibold leading-none text-dark-7 dark:text-gray-0">
        Submit this remix
      </h3>

      {data.map((source) => {
        const blocked = !!source.unavailable;

        return (
          <Group key={source.hostImageId} gap="sm" wrap="nowrap" align="flex-start">
            {/* Links out rather than opening the detail dialog: this sits inside
                a post the poster is mid-way through editing, and a dialog over it
                invites them to navigate away from unsaved work. */}
            <Link
              href={`/images/${source.hostImageId}`}
              target="_blank"
              rel="noreferrer"
              className="shrink-0"
            >
              {source.url ? (
                <EdgeMedia
                  src={source.url}
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
    </CustomCard>
  );
}
