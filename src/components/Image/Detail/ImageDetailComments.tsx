import { useBrowserRouter } from '~/components/BrowserRouter/BrowserRouterProvider';
import { CommentSection } from '~/components/CommentsV3/CommentSection';
import { SongCommentsProvider } from '~/components/Music/TimedComments/SongCommentsContext';
import type { SongImage } from '~/components/MusicPlayer/PostSong';
import { parseNumericString } from '~/utils/query-string-helpers';

type ImageDetailCommentsProps = {
  imageId: number;
  userId: number;
  /** The image as a song, when the detail view shows it as one: its comments can carry a time. */
  song?: SongImage;
};

export function ImageDetailComments({ imageId, userId, song }: ImageDetailCommentsProps) {
  // A routed dialog's `?highlight=` is in the browser router only; Next's still has the page's.
  const { query } = useBrowserRouter();
  const section = (
    <CommentSection
      entityType="image"
      entityId={imageId}
      ownerId={userId}
      title={null}
      hideSort
      borderless
      highlight={parseNumericString(query.highlight)}
    />
  );
  return song ? <SongCommentsProvider song={song}>{section}</SongCommentsProvider> : section;
}
