import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useMusicPlayerCover } from '~/components/MusicPlayer/useMusicPlayerCover';
import { ViewerBrowsingLevelScope } from '~/components/BrowsingLevel/BrowsingLevelProvider';

const PRIMARY = 'var(--mantine-primary-color-filled)';

/**
 * The colour environment behind a song's detail stage (Pencil `bgZ7u` "Cover environment"): the
 * cover, blurred, over a wash of its accent, under a dark scrim, so every song sets its own room.
 * With no cover the viewer may see, the wash is the Civitai primary.
 */
function SongStageBackdropContent({ songId }: { songId: number }) {
  const { cover, accent } = useMusicPlayerCover(songId);
  const from = accent?.accent2 ?? PRIMARY;
  const to = accent?.accent ?? PRIMARY;
  return (
    <div
      aria-hidden
      data-testid="song-stage-backdrop"
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden bg-dark-7"
    >
      <div
        className="absolute inset-[-15%] opacity-90 blur-[90px]"
        style={{ background: `linear-gradient(225deg, ${from}, ${to})` }}
      >
        {cover && (
          <EdgeMedia
            src={cover.url}
            type="image"
            width={450}
            name="Song cover"
            className="size-full object-cover"
            wrapperProps={{ className: 'size-full' }}
          />
        )}
      </div>
      <div className="absolute inset-0 bg-gradient-to-b from-[#14151766] to-[#141517B3]" />
    </div>
  );
}

// The viewer's level, not the detail page's: the page scopes its tree to the song's own rating.
export function SongStageBackdrop({ songId }: { songId: number }) {
  return (
    <ViewerBrowsingLevelScope>
      <SongStageBackdropContent songId={songId} />
    </ViewerBrowsingLevelScope>
  );
}
