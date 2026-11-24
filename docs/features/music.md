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

| Surface                    | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/music` (`MusicFeedPage`) | Title, genre chips, Recently played, Rising this week, then the "All music" feed: the image feed (`ImagesInfinite`) with `types: ['audio']`, with the images feed's sort, period and Filters panel, saved apart from `/images` (`music-filters` in localStorage), so neither feed's choices narrow the other. Linked from the header's content nav.                                                                                                                                                                                                                                                                                            |
| Genre chips                | "All" plus each genre of `SONG_GENRES` that has its mirrored tag (`songGenreTagName`); a genre no song was published under has no tag yet and gets no chip. Single-select, writing `?tags=<tag id>` (ids from `image.getSongGenreTags`); "All" clears it. A `?tags=` link that is not one genre lights no chip and "All" still clears it.                                                                                                                                                                                                                                                                                                      |
| Recently played            | The last 12 different songs this browser started in the player, newest first, kept in the player's saved preferences (per browser, not per account) and shown as Song Cards in one sideways-scrolling row. The row keeps the order it had when the page opened, so playing from it does not reorder it; new plays show on the next visit. Hidden when there are none.                                                                                                                                                                                                                                                                          |
| Rising this week           | The songs with the most plays today and the 6 days before, ties newest first, owners' and moderators' plays included; one list for everyone (`image.getRisingSongs`, refreshed every 10 minutes), narrowed on the server to the songs the viewer may open. The top 7 show as one large tile and up to six (on a phone, below `md`, the top 4: the large tile, two square ones and a wide one), laid out with no empty cell when there are fewer, and a lone song is one large tile; without a genre chip only the top 25 ids are read, with one picked every id is, and that genre's songs show. Hidden when no song has a play in the window. |
| Card / list view           | A grid / list switch beside the sort, kept per browser. Card: the Song Card. List: a Song Row per song (index, cover, title, "creator · genre", length, menu).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Song Card (`SongCard`)     | Any song in an image feed renders as one: cover, play button, length, title, creator, genre, plays, likes and comments.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Media filter               | The Filters panel's Media type section offers Audio beside Image and Video.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Profile music tab          | `/user/<name>/music` lists the creator's songs, with the song count on the profile's Music tab; the owner keeps the Published / Draft toggle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Playing a song from a list starts it with `playFromList` and the list's songs loaded at that moment,
in display order, so Up next shows the ones after it as "Next from <name>". A page loaded afterwards
is not added. A post's songs wrap: playing its last song puts the earlier ones in Up next.

Locally, without `FEED_SERVICE_URL`, "All music" falls back to the Postgres feed, which has no index
for the media type: on a large dev database a period wider than Week can run into the feed's
statement timeout, past the client's 8 s abort, so the feed retries forever. Keep the period at Week
when testing locally.

With Repeat all on and Up next played out, the panel lists under "Repeating" the songs that play
again after the current one. A cover with too little colour (a grey one) gives no accent: the player
then uses the Civitai primary, so Shuffle and Repeat read as on.

| Played from                                        | Up next name                       |
| -------------------------------------------------- | ---------------------------------- |
| `/music`                                           | "All music", or the selected genre |
| A profile's music tab                              | The creator's username             |
| Rising this week                                   | "Rising this week"                 |
| Recently played                                    | "Recently played"                  |
| A collection                                       | The collection's name              |
| Any other image feed (Audio picked in its filters) | "Images"                           |

Recently played and Rising read their song ids through the image feed, the same read the feed
uses, so a song the viewer may not see (removed, blocked, held, outside their browsing level, by a
hidden user or with a hidden tag) drops out.

Play counts (`image.getSongPlays`) are the songs' counted plays (see `entity-metrics.md`), only for
songs the viewer can open. A count cached before plays were read shows no number until the
count is next refreshed.

## Song detail view

A song opens in the image detail view (`/images/[id]`, `ImageDetail2`); there is no separate route. The
pieces live in `src/components/Music/SongDetail/`.

| Part                                     | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stage (`SongDetailStage`)                | The carousel slide of a song: the cover with a play button, title, creator (linking to their profile's music tab) and length, and the lyrics beside it, centred as one group (lyrics at most 720px wide; the cover grows from 320px to 400px from the `lg` container width). Arrows still browse the feed the view was opened from.                                                                                                      |
| Colour environment (`SongStageBackdrop`) | The cover, blurred, over a wash of its accent (`music-accent.ts`), under a dark scrim, once the image guard reveals the song. No cover the viewer may see: the Civitai primary.                                                                                                                                                                                                                                                          |
| Playback                                 | Through the global player only. Opening a song never autoplays. Play starts the song with the creator's other songs as Up next, which reads "Next from <creator>"; on the current song the button pauses and resumes instead of restarting. The cover shows "Playing m:ss" or "Paused" while it is the current song.                                                                                                                     |
| Synced lyrics (`SongLyrics`)             | While the song is current, the line the playhead has reached is highlighted (full white with an accent marker; the others dimmed) and followed. Clicking a timed line seeks there; when another song is current, this one starts at that line. A line with `t: null` renders as text and is not clickable. Lyrics with no times at all are plain text: no highlight, nothing to click. `[Verse 1]`-style lines render as section labels. |
| No lyrics                                | An "Instrumental" card with an equalizer. Legacy songs whose lyrics are only in `Image.metadata.lyrics` count as lyric-less. While the lyrics load, placeholder lines; if the read fails, "Lyrics couldn't load."                                                                                                                                                                                                                        |
| Action row                               | ImageDetail2's own reactions, Save, share, report and menu. Remix shows only when the song allows remixing (`metadata.allowRemix !== false`).                                                                                                                                                                                                                                                                                            |
| Up next (`SongUpNextButton`)             | Shown in the header while the player has a song; opens the player's Up next panel.                                                                                                                                                                                                                                                                                                                                                       |
| More from <creator> (`SongMoreFromCard`) | A sidebar card with up to six of the creator's other songs, from the image feed query (audio, the creator's id), each linking to its own detail view. Hidden when there are none. The image-only Remix gallery card is left out for songs.                                                                                                                                                                                               |
| Blurred by the image guard               | Title only: no cover, no lyrics, no play button until revealed.                                                                                                                                                                                                                                                                                                                                                                          |

The lyrics come from `image.getSongLyrics` (`src/server/services/track-lyrics.service.ts`). It returns the
lines only when the viewer may open the song and the song is reviewed and not blocked, for every viewer
including the owner and moderators; otherwise null. It refuses an image or video, and refuses everyone
while the flag is off. It is rate limited like `image.getSongCovers`.

Covers, the backdrop, the Up next panel and the More-from list read at the viewer's own browsing level
(`ViewerBrowsingLevelScope`), not the detail page's, which is scoped to the song's own rating.

The detail view shows no play count (Song Cards do). Not yet built: the Remixes half of the
Remixes / More-from card (no read of a song's remixes exists yet).

## Timed comments

A top-level comment on a song can sit at a time in it. The time is stored in `CommentV3.metadata` as
`{ "timestampSec": n }` (whole seconds), an object the server builds from the create input's
`timestampSec`; no client-supplied `metadata` is read. Everything here needs the `music` flag.

| Part                         | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Writing (`commentv3.create`) | `timestampSec` is accepted only on a top-level comment on an image of type audio, from a writer with the flag on, between 0 and the song's stored `metadata.duration`. A reply, another image or surface, a time past the end, or a song with no stored length is refused with a bad request; with the flag off, unauthorized. Edits never touch the time.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Composer chip                | On a song's comment section, the top-level composer shows "at m:ss" with the playhead. It is on while the song is the player's current song and sends the playhead's whole second when the comment is posted; off, the comment has no time. While another song (or none) plays it is disabled: "Play the song to comment at a time". It never sends a time past the song's stored length, and a song without one shows no chip, so its comments always post. Replies show no chip.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| List chip                    | A timed comment shows its time; clicking it seeks the current song there and plays it, or, when another song is current, starts this one there with the creator's songs as Up next (as a lyric line does).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Player bar (desktop)         | The comments' avatars float over the top edge of the waveform at their times (`MusicPlayerTimedComments`), taking no height in the bar. Avatars that would overlap at the waveform's width merge into a stack of up to three with a "+N" count; hovering or focusing it lists them ("Comments around m:ss", N total). When the playhead reaches a comment, its text floats as one label above the bar at its avatar, held inside the window, for 4 s; a later one replaces it, and a reached stack shows its comments one after another. Hovering or focusing an avatar shows its label. Clicking (or Enter on) an avatar seeks there, and a stack seeks to its first comment; clicking the label or a listed comment opens the song's detail view with that comment highlighted (`?highlight=<commentId>`). ArrowDown or ArrowUp moves from an avatar into its label and from a stack into its list; Escape closes them. The detail view unfolds its sidebar and Discussion card for that comment. On a phone they show only in the now-playing sheet (see On a phone). |
| Toggle                       | The bar's comment button hides the avatars; the waveform stays where it is, centred in the bar, and the comments are still read. The choice is kept per browser (`music-player:preferences` in local storage, through the player store) and defaults to on.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

The bar reads `commentv3.getTimed` (`getTimedComments` in `commentv3/read.service.ts`): live top-level
timed comments the viewer may see under the section's rules (ToS removals and excluded authors left out),
hidden ones left out too, ordered by time, at most 200, each with its text as plain text cut to 140
characters. Section items carry `timestampSec` (null on an untimed comment).

## On a phone

Below the `sm` breakpoint the player is a mini bar with two sheets over it
(`src/components/MusicPlayer/`, Pencil frame "09 Mobile").

| Part                                       | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mini bar (`MusicPlayerBar`)                | Cover, title and creator, a comments button (opens the song's detail view) and play/pause, over the cover's colours. Tapping the song opens the now-playing sheet. No timed comments and no close button: closing the player is in the sheet.                                                                                                                                                                                                                                                                                      |
| Now-playing sheet (`MusicNowPlayingSheet`) | Full height: "Playing from <list>", the cover, title, creator and like, the lyric line before the playhead, the current one (larger, full white, accent marker) and the next one (synced lyrics only), the waveform with the song's timed comments (the only place a phone shows them), the transport, and the comment count, Up next and Remix (when the song allows it). The same store, transport and timeline as the desktop bar. Closes by its chevron, a downward drag of its top, Escape and Back; its ✕ closes the player. |
| Up next sheet (`MusicUpNextSheet`)         | Opened from the now-playing sheet: the desktop panel's list (`MusicUpNextList`) in a bottom sheet, with the same sections (Queued by you, Next from <list>, Repeating), reorder by the grip, remove (always shown, as there is no hover), Clear, shuffle and repeat. Dark in both schemes, like the sheet under it. Closes by Escape, a downward drag of its top, Back and the scrim.                                                                                                                                              |
| Song detail (`SongDetailStage`)            | Below the `md` container width, a song with lyrics shows the cover or the lyrics in the same spot, with a Cover / Lyrics toggle under it; in the lyrics view a play/pause button sits beside the toggle. No lyrics, no toggle. From `md` up the two sit side by side as before.                                                                                                                                                                                                                                                    |

## A generated song's cover

An ACE-Step song's cover is never muxed into the song: the handler sends ACE no `cover`, so the song
is an MP3 like every other generator's and the song scan can read it. A cover the generator makes
(the suppressed `imageGen` step) or one the creator uploads (kept on the song step's metadata) is
linked when the song is posted, copied into a scanned image row (`linkGeneratedSongCover`). The
queue shows that image over the song. Songs posted before this, as an MP4 over their cover, fail the
song scan and need posting again.

Deleting a song deletes its cover. The song's `Track` row cascades with it and is the only link to
the cover, so both apps' image deletes (`deleteImagesWithOutcome` in the main app, `deleteImages` in
the moderator app) read the covers first (`readSongCovers`) and, once a song is gone, delete its cover
through the same delete. Only a row made for the song (`isCoverOfSong`: the owner's image, in no post,
whose `metadata.parentId` is the song) is deleted; any other linked image is left. A cover under a
hold is kept the way any image is: a child-safety case keeps and blocks it, and the moderator app's
own holds refuse it and report it. A song a hold keeps keeps its cover.

Replacing a cover (`setSongCover`) links the new one first, then deletes the old one through
`deleteImages`, so an old cover under a hold is kept and blocked instead, and never shown again. The
editor refreshes `image.getSongCovers` after the save. A player that still names the deleted cover
(another tab, another viewer) shows the placeholder instead of a broken image (`SongArt`), and the
detail backdrop keeps its colour wash alone, until its cover list refetches (at most
`SONG_LIST_STALE_MS`, 5 minutes). A load error does not refetch: during a CDN outage every card would
re-read the list at once.

## Playlists

A playlist is a collection of type `Music` ("Playlist" in the UI). It holds songs only, as
`imageId` items: `saveItemInCollections` and `upsertCollection` refuse a picture in a playlist and a
song in an image collection ("Collection type mismatch"), and `bulkSaveItems` adds only the songs.
Untyped collections still take either. Saving a song (its ⋯ menu, the player bar, the detail view's
share) opens "Add to Playlist". A playlist's page is the image collection page, where songs show as
Song Cards and play as a list. Playlists cannot be contests and have no review queue, judging or
collected-content reward. Songs saved to image collections before playlists existed stay there.

The `Music` type is offered in the create form and the type filter only with the `music` flag. Launch
order: deploy, apply the enum migration (`20271120150000_collection_type_music`) by hand, then turn
the flag on, so no playlist row exists before every reader can decode the value.

## The song menu

A song's ⋯ menu (`SongContextMenu`, Pencil `rUDmm`) is its own, not the image menu. It is used on the
feed card, the song row, the post page and the song detail view, and offers:

- Play now, Add to up next and Play next, for the list the song is shown in.
- Save to playlist (a published song), Share (the system share sheet, or the link copied) and Open song.
- For listeners: Report song, Hide this song, and hide or block the creator.
- For the owner and moderators: Delete song (not on a collection page, which removes from the collection).
- For moderators: Lookup song and post, Remove as ToS violation, Rescan song and Report CSAM.

The image menu's Add to Showcase, art frame and event decorations, More like this, storylines, the
minor and POI flags, View Post and Edit Post are not offered on a song. The moderator design's "ToS
cover image" and "Remove from feed" have no action yet.

## After launch

- **A music section on the profile overview.** The profile's Music tab lists a creator's songs; a
  section creators can place on their overview waits until after launch (decided 2026-11-20).
