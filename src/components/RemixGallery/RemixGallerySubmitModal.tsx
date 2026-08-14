import { Alert, Anchor, Button, Divider, Group, Loader, Modal, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconInfoCircle } from '@tabler/icons-react';
import clsx from 'clsx';
import { useState } from 'react';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { AspectRatioImageCard } from '~/components/CardTemplates/AspectRatioImageCard';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { useQueryImages } from '~/components/Image/image.utils';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { NoContent } from '~/components/NoContent/NoContent';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { PLACEMENT_SPEND_TYPES } from '~/shared/constants/placement.constants';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * Submitting one of your own images into someone's remix gallery.
 *
 * The picker only offers your own published images because that is what the
 * mutation accepts; showing anything else would be an invitation to a refusal.
 */
export function RemixGallerySubmitModal({ hostImageId }: { hostImageId: number }) {
  const dialog = useDialogContext();
  const currentUser = useCurrentUser();
  const utils = trpc.useUtils();
  const [selected, setSelected] = useState<number | null>(null);

  const { data: visibility, isError: visibilityFailed } =
    trpc.placement.getRemixGalleryVisibility.useQuery({ imageId: hostImageId });

  const { images, isLoading, fetchNextPage, hasNextPage, isRefetching } = useQueryImages(
    { userId: currentUser?.id, period: 'AllTime', limit: 50 },
    { enabled: !!currentUser }
  );

  const submit = trpc.placement.submitToRemixGallery.useMutation({
    onSuccess: () => {
      showSuccessNotification({
        title: 'Submitted',
        message: "Your remix is waiting for the creator's review.",
      });
      utils.placement.invalidate();
      dialog.onClose();
    },
    onError: (error) =>
      showErrorNotification({
        title: "Couldn't submit that",
        error: new Error(error.message),
      }),
  });

  const price = visibility?.price ?? null;

  // Filtered rather than shown-and-refused. Until the ceiling arrives nothing is
  // offered: rendering the whole grid first and removing images a moment later
  // invites a click on one that is about to disappear.
  const maxLevel = visibility?.maxSubmissionLevel;
  const eligible =
    maxLevel == null
      ? []
      : images.filter((image) => !!image.nsfwLevel && image.nsfwLevel <= maxLevel);
  // The picker's query backfills `browsingLevel`, which forces the
  // `nsfwLevel != 0` branch server-side, so an unrated image never arrives here
  // and every hidden one is genuinely over the ceiling.
  const overRated =
    maxLevel == null
      ? 0
      : images.filter((image) => !!image.nsfwLevel && image.nsfwLevel > maxLevel).length;

  return (
    // `padding={0}` would strip the header's padding too, putting the title and
    // the close button against the edges. Only the body needs to lose it, so the
    // scroll container can run edge to edge and own its own insets.
    <Modal
      {...dialog}
      // Spans, not a `div`/`Text` stack: Mantine renders the title inside an
      // `h2`, and block elements there are invalid nesting that React reparses.
      title={
        <span className="flex flex-col gap-0.5">
          <span>Submit your remix</span>
          <Text span size="xs" fw={400} c="dimmed" className="block leading-snug">
            The creator reviews every submission and decides what belongs in their gallery.
          </Text>
        </span>
      }
      size="lg"
      classNames={{ body: 'p-0', header: 'items-start pb-3' }}
    >
      {/* Three bands: the explanation and the actions stay put, only the picker
          scrolls. The fee warning is money copy, so it must not be the thing
          that scrolls out of sight while someone hunts for an image. */}
      <div className="flex max-h-[70vh] flex-col">
        <Stack gap="xs" className="shrink-0 px-4 pb-3 pt-0">
          {/* Footnotes on the title's sentence, not statements of equal weight —
              icon rows in the crypto deposit card's shape, so a stack of them
              reads as one block rather than as paragraphs. */}
          <Stack gap={4}>
            {/* The picker lists published images because that is all the mutation
                accepts, and a freshly generated image is not one. Said here rather
                than only in the empty state: the case that confuses people is
                having images in the grid and not the one they just made. */}
            <Group gap="xs" wrap="nowrap" align="flex-start">
              <IconInfoCircle
                size={14}
                className="text-blue-5"
                style={{ flexShrink: 0, marginTop: 2 }}
              />
              <Text size="xs" c="dimmed">
                Only images you have posted appear below.{' '}
                <Anchor href="/posts/create" target="_blank" rel="noreferrer" size="xs">
                  Post your remix first
                </Anchor>{' '}
                if you don&apos;t see it.
              </Text>
            </Group>

            {/* Says why the grid is short. Without it a submitter whose work is
                mostly mature sees a picker missing their best images and no
                reason, which reads as a bug rather than a rule. The reason is not
                named: which rule bit is the host's business, not the
                submitter's. */}
            {maxLevel === 0 ? (
              <Group gap="xs" wrap="nowrap" align="flex-start">
                <IconAlertTriangle
                  size={14}
                  className="text-yellow-500"
                  style={{ flexShrink: 0, marginTop: 2 }}
                />
                <Text size="xs" c="dimmed">
                  This image has no rating yet, so nothing can be submitted to it.
                </Text>
              </Group>
            ) : (
              overRated > 0 && (
                <Group gap="xs" wrap="nowrap" align="flex-start">
                  <IconAlertTriangle
                    size={14}
                    className="text-yellow-500"
                    style={{ flexShrink: 0, marginTop: 2 }}
                  />
                  <Text size="xs" c="dimmed">
                    {overRated === 1 ? '1 of your images is' : `${overRated} of your images are`}{' '}
                    rated above what this gallery accepts, so{' '}
                    {overRated === 1 ? 'it is' : 'they are'} not shown.
                  </Text>
                </Group>
              )
            )}

            {visibility && !visibility.open && (
              <Group gap="xs" wrap="nowrap" align="flex-start">
                <IconAlertTriangle
                  size={14}
                  className="text-yellow-500"
                  style={{ flexShrink: 0, marginTop: 2 }}
                />
                <Text size="xs" c="yellow">
                  This creator has stopped accepting submissions.
                </Text>
              </Group>
            )}
          </Stack>
        </Stack>

        <Divider />

        {/* The scroll container, and the only thing that pages. `InViewLoader`
            fires on viewport intersection, so it has to live inside here — it
            is reached by scrolling this box, not the page. */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {/* Waits on the ceiling as well as the images: without it the picker
              renders "you have nothing to submit" for a beat while the rule is
              still in flight. */}
          {visibilityFailed && !visibility ? (
            // An errored query settles with no data and isLoading false, so
            // waiting on `visibility` alone spins here forever with nothing to
            // read and nothing to press. Gated on `!visibility` as well, because
            // React Query keeps the previous data through a failed refetch — the
            // error alone would replace a working, already-populated picker.
            <Alert color="red" icon={<IconAlertTriangle />}>
              Couldn&apos;t load this gallery. Close this and try again.
            </Alert>
          ) : isLoading || !visibility ? (
            <Group justify="center" py="xl">
              <Loader />
            </Group>
          ) : eligible.length ? (
            <>
              <div className="grid grid-cols-4 gap-3">
                {eligible.map((image) => (
                  <AspectRatioImageCard
                    key={image.id}
                    aspectRatio="square"
                    image={image}
                    onClick={() => setSelected(image.id)}
                    className={clsx(
                      'cursor-pointer',
                      selected === image.id && 'ring-2 ring-blue-5'
                    )}
                  />
                ))}
              </div>

              {/* Scroll-to-load, which is what a populated grid should do. */}
              {hasNextPage && (
                <InViewLoader loadFn={fetchNextPage} loadCondition={!isRefetching}>
                  <Group justify="center" py="md">
                    <Loader size="sm" />
                  </Group>
                </InViewLoader>
              )}
            </>
          ) : (
            <NoContent
              message={
                maxLevel == null
                  ? // Three different reasons collapse into a null ceiling, and
                    // naming the wrong one is worse than saying less: signed
                    // out, gallery closed, or a host that cannot show a gallery
                    // at all (mid-rescan, blocked, under review).
                    !currentUser
                    ? 'Sign in to submit a remix to this gallery.'
                    : visibility?.open
                    ? 'This image cannot show a gallery right now.'
                    : 'This gallery is not open for submissions.'
                  : maxLevel === 0
                  ? 'This image has no rating yet, so nothing can be submitted to it.'
                  : hasNextPage
                  ? // Hedged while pages remain, because every count here is
                    // computed from what has loaded. Phrased as a paused state
                    // rather than an active one: nothing is fetching now, the
                    // button below is the action.
                    'Nothing so far in the images loaded.'
                  : overRated > 0
                  ? 'None of your posted images are rated low enough for this gallery.'
                  : "You don't have any posted images to submit yet. Post your remix first, then submit it here."
              }
            />
          )}

          {/* A button rather than the in-view loader used above. With nothing
              eligible there is no content between the loader and the top of the
              scroll box, so it would sit permanently in view: fire, load 50,
              still be in view, fire again — walking the whole library in a burst
              of requests, in exactly the case where nothing will be found.
              Paging past the first page is worth doing, but on intent. */}
          {!eligible.length && hasNextPage && !isLoading && visibility && (
            <Group justify="center" mt={-12} pb="sm">
              <Button
                variant="subtle"
                size="compact-sm"
                loading={isRefetching}
                onClick={() => fetchNextPage()}
              >
                Keep looking through your images
              </Button>
            </Group>
          )}
        </div>

        <Divider />

        {/* Same shape as the crypto deposit card's warnings. The amount is the
            server's own figure, computed with the helper the refund uses from
            the operator-set rate — quoting "30%" here would be a number this
            file cannot keep true, and it is the one fact a submitter needs
            before spending. */}
        <div className="flex shrink-0 items-center justify-between gap-3 px-4 py-3">
          {visibility?.declineFee ? (
            // `min-w-0` is what makes the note wrap instead of pushing: a flex
            // item's floor is its content width otherwise, so a long sentence
            // squeezed the Submit button until its label clipped.
            <Group gap="xs" wrap="nowrap" align="flex-start" className="min-w-0 flex-1">
              <IconAlertTriangle
                size={14}
                className="text-yellow-500"
                style={{ flexShrink: 0, marginTop: 2 }}
              />
              <Text size="xs" c="dimmed">
                If your remix is declined, the creator keeps {visibility.declineFee} Buzz and the
                rest comes back.
              </Text>
            </Group>
          ) : (
            <span className="flex-1" />
          )}
          <div className="shrink-0">
            {/* The price shown here is the one the balance check runs against, and
              the owner can move it between this render and the click. The
              mutation reads the price fresh, so the button is honest about
              affordability but cannot promise the amount — hence the note above
              it rather than a silent charge. */}
            <BuzzTransactionButton
              buzzAmount={price ?? 0}
              // Yellow and Green only, matching what the escrow will actually
              // draw. The mutation refuses Blue regardless, so offering it here
              // would promise a payment that is then refused.
              accountTypes={PLACEMENT_SPEND_TYPES}
              label="Submit"
              disabled={!selected || !visibility?.open || price == null}
              loading={submit.isPending}
              // The price this render displayed travels with the submission, so
              // the server refuses rather than charging a number the submitter
              // never agreed to. Affordability was checked against this one too.
              onPerformTransaction={() =>
                selected != null &&
                price != null &&
                submit.mutate({ hostImageId, imageId: selected, expectedPrice: price })
              }
            />
          </div>
        </div>
      </div>
    </Modal>
  );
}
