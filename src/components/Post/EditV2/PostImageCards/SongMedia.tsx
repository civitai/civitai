import clsx from 'clsx';
import { SongCover } from '~/components/Post/EditV2/PostImageCards/SongCover';
import { SongPreviewPlayer } from '~/components/Post/EditV2/PostImageCards/SongPreviewPlayer';
import { audioMetadataSchema } from '~/server/schema/media.schema';
import type { PostEditImageDetail } from '~/server/services/post.service';

/** A song's media column in the post editor: its cover, with the card controls over it, and the player. */
export function SongMedia({
  image,
  coverOverlay,
  className,
}: {
  image: PostEditImageDetail;
  coverOverlay?: React.ReactNode;
  className?: string;
}) {
  const duration = audioMetadataSchema.partial().safeParse(image.metadata).data?.duration;
  return (
    <div className={clsx('flex flex-col gap-3', className)}>
      <div className="relative mx-auto w-full max-w-[320px]">
        <SongCover image={image} />
        {coverOverlay}
      </div>
      <SongPreviewPlayer src={image.url} duration={duration} />
    </div>
  );
}
