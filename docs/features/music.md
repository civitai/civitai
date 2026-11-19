# Music: songs on Civitai

A song is an `Image` row with `type: audio`, behind the `music` feature flag (`useFeatureFlags().music` on
the client, `ctx.features.music` on the server). With the flag off, songs are not created and none of the
surfaces below change anything.

- **Global player:** `src/store/music-player.store.ts` holds the current song, Up next and playback; one
  `<audio>` element (`MusicPlayerAudio`) plays it. Every surface starts a song with `playFromList`.
  The bar's cover and title open the song's detail view, and the creator's name opens the music tab
  of their profile (`songCreatorHref`).
- **Lyrics:** stored in `TrackLyrics.lines` as `[{ t, text }]`, `t` in milliseconds or null when the
  line has no time.
- **Visibility:** a song shows only once it is reviewed (`songReviewedSql` / `imageReviewedSql` in
  `src/server/common/image-visibility.ts`), which for a song includes the verdict on its lyrics text.

## Discovery

The surfaces where people find songs, all hidden with the flag off (`/music` and `/user/<name>/music`
are not found, and no music nav entry, chip or tab shows).

| Surface                    | Behaviour                                                                                                                                                                                                                                                                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/music` (`MusicFeedPage`) | Title, genre chips, then the "All music" feed: the image feed (`ImagesInfinite`) with `types: ['audio']`, so sort, period and the Filters panel are the images feed's (and share its saved choices). Linked from the header's content nav.                                                                                                |
| Genre chips                | "All" plus each genre of `SONG_GENRES` that has its mirrored tag (`songGenreTagName`); a genre no song was published under has no tag yet and gets no chip. Single-select, writing `?tags=<tag id>` (ids from `image.getSongGenreTags`); "All" clears it. A `?tags=` link that is not one genre lights no chip and "All" still clears it. |
| Card / list view           | A grid / list switch beside the sort, kept per browser. Card: the Song Card. List: a Song Row per song (index, cover, title, "creator · genre", length, menu).                                                                                                                                                                            |
| Song Card (`SongCard`)     | Any song in an image feed renders as one: cover, play button, length, title, creator, genre, likes and comments.                                                                                                                                                                                                                          |
| Media filter               | The Filters panel's Media type section offers Audio beside Image and Video.                                                                                                                                                                                                                                                               |
| Profile music tab          | `/user/<name>/music` lists the creator's songs, with the song count on the profile's Music tab; the owner keeps the Published / Draft toggle.                                                                                                                                                                                             |

Playing a song from a list starts it with `playFromList` and the list's songs loaded at that moment,
in display order, so Up next shows the ones after it as "Next from <name>". A page loaded afterwards
is not added.

| Played from                                        | Up next name                       |
| -------------------------------------------------- | ---------------------------------- |
| `/music`                                           | "All music", or the selected genre |
| A profile's music tab                              | The creator's username             |
| A collection                                       | The collection's name              |
| Any other image feed (Audio picked in its filters) | "Images"                           |

"Rising this week" and "Recently played" on `/music` come later.

## Song detail view

A song opens in the image detail view (`/images/[id]`, `ImageDetail2`); there is no separate route. The
pieces live in `src/components/Music/SongDetail/`.

| Part | Behaviour |
|------|-----------|
| Stage (`SongDetailStage`) | The carousel slide of a song: the cover with a play button, title, creator (linking to their profile's music tab) and length, and the lyrics beside it, centred as one group (lyrics at most 720px wide; the cover grows from 320px to 400px from the `lg` container width). Arrows still browse the feed the view was opened from. |
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
| Composer chip | On a song's comment section, the top-level composer shows "at m:ss" with the playhead. It is on while the song is the player's current song and sends the playhead's whole second when the comment is posted; off, the comment has no time. While another song (or none) plays it is disabled: "Play the song to comment at a time". It never sends a time past the song's stored length, and a song without one shows no chip, so its comments always post. Replies show no chip. |
| List chip | A timed comment shows its time; clicking it seeks the current song there and plays it, or, when another song is current, starts this one there with the creator's songs as Up next (as a lyric line does). |
| Player bar (desktop) | The comments' avatars float over the top edge of the waveform at their times (`MusicPlayerTimedComments`), taking no height in the bar. Avatars that would overlap at the waveform's width merge into a stack of up to three with a "+N" count; hovering or focusing it lists them ("Comments around m:ss", N total). When the playhead reaches a comment, its text floats as one label above the bar at its avatar, held inside the window, for 4 s; a later one replaces it, and a reached stack shows its comments one after another. Hovering or focusing an avatar shows its label. Clicking (or Enter on) an avatar seeks there, and a stack seeks to its first comment; clicking the label or a listed comment opens the song's detail view with that comment highlighted (`?highlight=<commentId>`). ArrowDown or ArrowUp moves from an avatar into its label and from a stack into its list; Escape closes them. The detail view unfolds its sidebar and Discussion card for that comment. The phone bar shows none. |
| Toggle | The bar's comment button hides the avatars; the waveform stays where it is, centred in the bar, and the comments are still read. The choice is kept per browser (`music-player:preferences` in local storage, through the player store) and defaults to on. |

The bar reads `commentv3.getTimed` (`getTimedComments` in `commentv3/read.service.ts`): live top-level
timed comments the viewer may see under the section's rules (ToS removals and excluded authors left out),
hidden ones left out too, ordered by time, at most 200, each with its text as plain text cut to 140
characters. Section items carry `timestampSec` (null on an untimed comment).

