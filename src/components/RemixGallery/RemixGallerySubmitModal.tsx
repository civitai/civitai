import { Alert, Button, Divider, Group, Loader, Modal, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
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

  const { data: visibility } = trpc.placement.getRemixGalleryVisibility.useQuery({
    imageId: hostImageId,
  });

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

  return (
    // `padding={0}` would strip the header's padding too, putting the title and
    // the close button against the edges. Only the body needs to lose it, so the
    // scroll container can run edge to edge and own its own insets.
    <Modal
      {...dialog}
      title="Submit your remix"
      size="lg"
      classNames={{ body: 'p-0', header: 'pb-2' }}
    >
      {/* Three bands: the explanation and the actions stay put, only the picker
          scrolls. The fee warning is money copy, so it must not be the thing
          that scrolls out of sight while someone hunts for an image. */}
      <div className="flex max-h-[70vh] flex-col">
        <Stack gap="xs" className="shrink-0 px-4 pb-3 pt-0">
          {/* The decline consequence used to be said here too. The footer now
              states it with the actual number, and saying it twice made the
              vaguer version the one people read first. */}
          <Text size="sm" c="dimmed">
            The creator reviews every submission and decides what belongs in their gallery.
          </Text>

          {visibility && !visibility.open && (
            <Alert color="yellow" icon={<IconAlertTriangle />}>
              This creator has stopped accepting submissions.
            </Alert>
          )}
        </Stack>

        <Divider />

        {/* The scroll container, and the only thing that pages. `InViewLoader`
            fires on viewport intersection, so it has to live inside here — it
            is reached by scrolling this box, not the page. */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {isLoading ? (
            <Group justify="center" py="xl">
              <Loader />
            </Group>
          ) : images.length ? (
            <>
              <div className="grid grid-cols-4 gap-3">
                {images.map((image) => (
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

              {hasNextPage && (
                <InViewLoader loadFn={fetchNextPage} loadCondition={!isRefetching}>
                  <Group justify="center" py="md">
                    <Loader size="sm" />
                  </Group>
                </InViewLoader>
              )}
            </>
          ) : (
            <NoContent message="You don't have any published images to submit yet." />
          )}
        </div>

        <Divider />

        {/* Same shape as the crypto deposit card's warnings. The amount is the
            server's own figure, computed with the helper the refund uses from
            the operator-set rate — quoting "30%" here would be a number this
            file cannot keep true, and it is the one fact a submitter needs
            before spending. */}
        <Group justify="space-between" gap="sm" wrap="nowrap" className="shrink-0 px-4 py-3">
          {visibility?.declineFee ? (
            <Group gap="xs" wrap="nowrap" align="flex-start">
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
            <span />
          )}
          <Group gap="sm" wrap="nowrap">
            <Button variant="default" onClick={dialog.onClose}>
              Cancel
            </Button>
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
          </Group>
        </Group>
      </div>
    </Modal>
  );
}
