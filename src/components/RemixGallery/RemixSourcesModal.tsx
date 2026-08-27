import { Loader, Modal, Text } from '@mantine/core';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { NoContent } from '~/components/NoContent/NoContent';
import { RemixSourcesList, useRemixSources } from '~/components/RemixGallery/RemixSourcesList';

/**
 * Submitting a remix to the galleries of the images it came from, from anywhere
 * the remix itself is on screen — a feed card, the generator, the queue.
 *
 * The inverse of `RemixGallerySubmitModal`, which starts from a host image and
 * asks which of your images to put in it. This one starts from the remix and
 * asks which of its sources to send it to, so it never renders a picker: the
 * hosts come from the image's own provenance and the caller cannot name them.
 *
 * Unlike the post editor's card, this one is reached deliberately, so an image
 * with no sources gets a sentence rather than nothing — the alternative is a
 * menu item that opens an empty dialog.
 */
export function RemixSourcesModal({
  imageId,
  published,
}: {
  imageId: number;
  /** Only changes what the success message promises; both states submit here. */
  published: boolean;
}) {
  const dialog = useDialogContext();
  const { sources, isLoading } = useRemixSources(imageId);

  return (
    <Modal
      {...dialog}
      // Spans, not a `div`/`Text` stack: Mantine renders the title inside an
      // `h2`, and block elements there are invalid nesting that React reparses.
      title={
        <span className="flex flex-col gap-0.5">
          <span>Submit this remix</span>
          <Text span size="xs" fw={400} c="dimmed" className="block leading-snug">
            The creator reviews every submission and decides what belongs in their gallery.
          </Text>
        </span>
      }
      size="sm"
      centered
    >
      <div className="flex flex-col gap-3">
        {isLoading ? (
          <div className="flex justify-center py-4">
            <Loader size="sm" />
          </div>
        ) : sources?.length ? (
          /* Deliberately not closed on success. The submitted row comes back as
             "Already submitted", which is the confirmation, and closing would
             hide the other sources on the rare image that has more than one. */
          <RemixSourcesList imageId={imageId} published={published} />
        ) : (
          <NoContent message="This image isn't linked to anything you can submit it to." />
        )}
      </div>
    </Modal>
  );
}
