import { Tooltip } from '@mantine/core';
import { IconExternalLink } from '@tabler/icons-react';
import { AspectRatioImageCard } from '~/components/CardTemplates/AspectRatioImageCard';
import type { RouterOutput } from '~/types/router';

type PendingSubmission =
  RouterOutput['placement']['getPendingRemixGallerySubmissions']['items'][number];

/**
 * The submitted image, openable.
 *
 * Approving or declining off a thumbnail is deciding without looking, and until
 * this existed there was nowhere to look — a submission appears in the manage
 * modal and the submissions page, and neither linked anywhere.
 *
 * A new tab rather than navigation: both callers are queues with other rows
 * still waiting on them, and sending the reviewer away to see one submission
 * loses the list and their place in it.
 */
export function SubmissionThumb({ image }: { image: NonNullable<PendingSubmission['image']> }) {
  return (
    <Tooltip label="Open this remix in a new tab" withArrow openDelay={400}>
      <a
        href={`/images/${image.id}`}
        target="_blank"
        rel="noreferrer"
        className="group relative block w-20 shrink-0"
      >
        {/* `explain={false}` because this is 80px wide. The default renders the
            centered "This image is rated X" block with its own Show button on
            top of the corner toggle — two reveal controls on one thumbnail, and
            at this size the centered one covers the whole tile and takes the
            click that should open the image. The corner toggle is the reveal. */}
        <AspectRatioImageCard aspectRatio="square" image={image} explain={false} />
        {/* Hidden until hover: the affordance has to be discoverable without
            putting a permanent scrim over every thumbnail in the queue. */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-md bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
          <IconExternalLink size={18} className="text-white" />
        </div>
      </a>
    </Tooltip>
  );
}
