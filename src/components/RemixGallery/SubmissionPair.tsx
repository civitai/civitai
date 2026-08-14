import { Center, Skeleton, Text, Tooltip } from '@mantine/core';
import { IconEyeOff, IconPhotoOff } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { SubmissionThumb } from '~/components/RemixGallery/SubmissionThumb';
import { getBrowsingLevelLabel } from '~/shared/constants/browsingLevel.constants';
import type { RouterOutput } from '~/types/router';

type QueueImage = NonNullable<
  RouterOutput['placement']['getPendingRemixGallerySubmissions']['items'][number]['image']
>;

/**
 * Stands in for an image that will not resolve — deleted, unpublished, still
 * ingesting, or filtered by the visibility rules the feed applies.
 *
 * The row survives it: the action beside it is the only route to the escrow
 * behind it, so a missing preview must not take the decision with it.
 */
function MissingThumb({ reason }: { reason: string }) {
  return (
    <Tooltip label={reason} withArrow>
      <div className="relative w-20 shrink-0">
        <Skeleton animate={false} className="aspect-square w-full rounded-md" />
        <Center className="absolute inset-0">
          <IconPhotoOff size={20} className="text-dimmed" />
        </Center>
      </div>
    </Tooltip>
  );
}

/**
 * An image this domain may not be served.
 *
 * Deliberately not a blurred tile with a reveal: there is nothing behind it to
 * reveal, because the asset was never sent. Showing a Show button that cannot
 * work is worse than showing none. The rating is named instead, which is what
 * the reviewer needs to decide.
 */
export function WithheldThumb({ nsfwLevel }: { nsfwLevel: number }) {
  const rating = getBrowsingLevelLabel(nsfwLevel);
  return (
    <Tooltip label={`Rated ${rating} — not viewable on this domain`} withArrow>
      <div className="relative flex aspect-square w-20 shrink-0 flex-col items-center justify-center gap-1 rounded-md border border-solid border-gray-3 bg-gray-1 dark:border-dark-4 dark:bg-dark-6">
        <IconEyeOff size={18} className="text-dimmed" />
        <Text size="xs" fw={600} className="leading-none">
          {rating}
        </Text>
      </div>
    </Tooltip>
  );
}

/**
 * The three states a queue image can arrive in, in one place.
 *
 * Exported because both review surfaces need the same branch, and two copies of
 * "what do we draw when there are no pixels" is how one of them ends up drawing
 * a reveal control over an asset that was never sent.
 *
 * No href of its own: the callers point at different things — the submissions
 * page at the image, the manage modal at the host on the domain that can serve
 * it — so the link belongs beside the tile rather than inside it.
 */
export function QueueThumb({
  image,
  label,
  missing,
}: {
  image: QueueImage | null;
  label: string;
  missing: string;
}) {
  if (!image) return <MissingThumb reason={missing} />;
  // The union is the control: with `viewable: false` there is no url to reach
  // for, so this cannot fall through to a card that expects one.
  if (!image.viewable) return <WithheldThumb nsfwLevel={image.nsfwLevel} />;
  return <SubmissionThumb image={image} label={label} />;
}

function Captioned({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div className="flex w-20 shrink-0 flex-col gap-1">
      {children}
      <Text size="xs" c="dimmed" ta="center" className="leading-none">
        {caption}
      </Text>
    </div>
  );
}

/**
 * The host image beside the remix of it.
 *
 * Showing only the submission asks the reviewer to judge it against an image
 * they have to go and open, and the round trip loses their place in the queue.
 * Both are captioned because at this size, side by side, nothing else says which
 * is whose — and the two tabs put them in opposite roles.
 */
export function SubmissionPair({
  host,
  remix,
  hostCaption,
  remixCaption,
  hostLabel,
  remixLabel,
  hostMissing,
  remixMissing = 'This image is no longer available to preview',
}: {
  host: QueueImage | null;
  remix: QueueImage | null;
  hostCaption: string;
  remixCaption: string;
  hostLabel: string;
  remixLabel: string;
  hostMissing: string;
  remixMissing?: string;
}) {
  return (
    <div className="flex shrink-0 gap-2">
      <Captioned caption={hostCaption}>
        <QueueThumb image={host} label={hostLabel} missing={hostMissing} />
      </Captioned>
      <Captioned caption={remixCaption}>
        <QueueThumb image={remix} label={remixLabel} missing={remixMissing} />
      </Captioned>
    </div>
  );
}
