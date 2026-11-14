import { CommentSection } from '~/components/CommentsV3/CommentSection';
import { SongCommentsProvider } from '~/components/Music/TimedComments/SongCommentsContext';
import type { SongImage } from '~/components/MusicPlayer/PostSong';

type ImageDetailCommentsProps = {
  imageId: number;
  userId: number;
  /** The image as a song, when the detail view shows it as one: its comments can carry a time. */
  song?: SongImage;
};

export function ImageDetailComments({ imageId, userId, song }: ImageDetailCommentsProps) {
  const section = (
    <CommentSection
      entityType="image"
      entityId={imageId}
      ownerId={userId}
      title={null}
      hideSort
      borderless
    />
  );
  return song ? <SongCommentsProvider song={song}>{section}</SongCommentsProvider> : section;
}
