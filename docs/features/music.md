# Music: songs on Civitai

A song is an `Image` row with `type: audio`, behind the `music` feature flag (`useFeatureFlags().music` on
the client, `ctx.features.music` on the server). With the flag off, songs are not created and none of the
surfaces below change anything.

- **Global player:** `src/store/music-player.store.ts` holds the current song, Up next and playback; one
  `<audio>` element (`MusicPlayerAudio`) plays it. Every surface starts a song with `playFromList`.
  The bar's cover and title open the song's detail view, and the creator's name opens their profile
  (`songCreatorHref`; profiles have no music section yet).
- **Lyrics:** stored in `TrackLyrics.lines` as `[{ t, text }]`, `t` in milliseconds or null when the
  line has no time.
- **Visibility:** a song shows only once it is reviewed (`songReviewedSql` / `imageReviewedSql` in
  `src/server/common/image-visibility.ts`), which for a song includes the verdict on its lyrics text.

## Song detail view

A song opens in the image detail view (`/images/[id]`, `ImageDetail2`); there is no separate route. The
pieces live in `src/components/Music/SongDetail/`.

| Part | Behaviour |
|------|-----------|
| Stage (`SongDetailStage`) | The carousel slide of a song: the cover with a play button, title, creator (linking to their profile) and length, and the lyrics beside it, centred as one group (lyrics at most 720px wide; the cover grows from 320px to 400px from the `lg` container width). Arrows still browse the feed the view was opened from. |
| Colour environment (`SongStageBackdrop`) | The cover, blurred, over a wash of its accent (`music-accent.ts`), under a dark scrim, once the image guard reveals the song. No cover the viewer may see: the Civitai primary. |
| Playback | Through the global player only. Opening a song never autoplays. Play starts the song with the creator's other songs as Up next, which reads "Next from <creator>"; on the current song the button pauses and resumes instead of restarting. The cover shows "Playing m:ss" or "Paused" while it is the current song. |
| Synced lyrics (`SongLyrics`) | While the song is current, the line the playhead has reached is highlighted and followed. Clicking a timed line seeks there; when another song is current, this one starts at that line. A line with `t: null` renders as text and is not clickable. Lyrics with no times at all are plain text: no highlight, nothing to click. `[Verse 1]`-style lines render as section labels. |
| No lyrics | An "Instrumental" card with an equalizer. Legacy songs whose lyrics are only in `Image.metadata.lyrics` count as lyric-less. While the lyrics load, placeholder lines; if the read fails, "Lyrics couldn't load." |
| Action row | ImageDetail2's own reactions, Save, share, report and menu. Remix shows only when the song allows remixing (`metadata.allowRemix !== false`). |
| Up next (`SongUpNextButton`) | Shown in the header while the player has a song; opens the player's Up next panel. |
| More from <creator> (`SongMoreFromCard`) | A sidebar card with up to six of the creator's other songs, from the image feed query (audio, the creator's id), each linking to its own detail view. Hidden when there are none. The image-only Remix gallery card is left out for songs. |
| Blurred by the image guard | Title only: no cover, no lyrics, no play button until revealed. |

The lyrics come from `image.getSongLyrics` (`src/server/services/track-lyrics.service.ts`). It returns the
lines only when the viewer may open the song and the song is reviewed and not blocked, for every viewer
including the owner and moderators; otherwise null. It refuses an image or video, and refuses everyone
while the flag is off. It is rate limited like `image.getSongCovers`.

Covers, the backdrop, the Up next panel and the More-from list read at the viewer's own browsing level
(`ViewerBrowsingLevelScope`), not the detail page's, which is scoped to the song's own rating.

Not yet built: play counts (waiting on `'Play'` events being readable) and the Remixes half of the
Remixes / More-from card (no read of a song's remixes exists yet).

## Timed comments

A top-level comment on a song can sit at a time in it. The time is stored in `CommentV3.metadata` as
`{ "timestampSec": n }` (whole seconds), an object the server builds from the create input's
`timestampSec`; no client-supplied `metadata` is read. Everything here needs the `music` flag.

| Part | Behaviour |
|------|-----------|
| Writing (`commentv3.create`) | `timestampSec` is accepted only on a top-level comment on an image of type audio, from a writer with the flag on, between 0 and the song's stored `metadata.duration`. A reply, another image or surface, a time past the end, or a song with no stored length is refused with a bad request; with the flag off, unauthorized. Edits never touch the time. |
| Composer chip | On a song's comment section, the top-level composer shows "at m:ss" with the playhead. It is on while the song is the player's current song and sends the playhead's whole second when the comment is posted; off, the comment has no time. While another song (or none) plays it is disabled: "Play the song to comment at a time". Replies show no chip. |
| List chip | A timed comment shows its time; clicking it seeks the current song there and plays it, or, when another song is current, starts this one there with the creator's songs as Up next (as a lyric line does). |
| Player bar (desktop) | The comments' avatars sit on a strip above the waveform at their times (`MusicPlayerTimedComments`). When the playhead reaches one, its text shows as one label for 4 s; a later one replaces it. Hovering an avatar shows its label; clicking it seeks there. The phone bar shows none. |
| Toggle | The bar's comment button hides the strip and stops the read. The choice is kept per browser (`music-player:timed-comments` in local storage) and defaults to on. |

The bar reads `commentv3.getTimed` (`getTimedComments` in `commentv3/read.service.ts`): live top-level
timed comments the viewer may see under the section's rules (ToS removals and excluded authors left out),
hidden ones left out too, ordered by time, at most 200, each with its text as plain text cut to 140
characters. Section items carry `timestampSec` (null on an untimed comment).

