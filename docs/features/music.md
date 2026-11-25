# Music: songs on Civitai

A song is an `Image` row with `type: audio`, behind the `music` feature flag (`useFeatureFlags().music` on
the client, `ctx.features.music` on the server). With the flag off, songs are not created and none of the
surfaces below change anything.

Without the flag a viewer gets no song from a generic image read either, except their own (moderators
see them all): the image feeds (every feed route loads its rows through `getAllImagesUncaptured`, so
`image.getInfinite`, `image.getImagesAsPostsInfinite`, `/api/v1/images`, collection, profile and model
galleries), `image.get` and the by-id reads behind `assertImageVisibleToViewer` (generation data,
detail, contest details), entity and collection covers, post image lists (`getImagesForPosts`) and
model-version showcases. The clause is `songsHiddenSql` (`song-visibility-sql.ts`). The shared
showcase cache (`imagesForModelVersionsCache`) is read by every viewer, so it holds no song: the
model-version carousel never shows one, and owners see theirs in the gallery. The collections search
index holds no song cover, and a collection's own cover that is a song is shown only to its owner,
moderators and `music` flag holders. feed-go reads the
`music` flag per viewer from Flipt (`internal/server/music.go`) and applies the same rule.

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

For a requester with the `music` flag, an ACE-Step song's cover is never muxed into the song: the
handler sends ACE no `cover`, so the song is an MP3 like every other generator's and the song scan can
read it. A requester without the flag can't post a song, so the handler sends the cover (generated or
uploaded) and ACE returns an MP4 over it, as before songs existed (`GenerationHandlerCtx.canUseMusic`). A cover the generator makes
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
Untyped collections still take either. Creating or editing a playlist, and saving into one (or saving
a song anywhere), needs the `music` flag: without it these refuse with "Songs are not available yet." Saving a song (its ⋯ menu, the player bar, the detail view's
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
- For the owner: Dispute rating, with the `ratingDispute` flag, once the song's own scans have
  reviewed it (see "Rating disputes" below).
- For the owner and moderators: Delete song (not on a collection page, which removes from the collection).
- For moderators: Lookup song and post, Remove as ToS violation, Remove cover, Rescan song and Report
  CSAM. Remove cover (`image.removeSongCover`) removes only the song's own cover, with its own
  violation type, and leaves the song up with the placeholder. It is hidden while the song has no own
  cover, and refused for every moderator while the cover is held for CSAM review (its own flag or
  block, a held owner, or a CSAM signal on its bytes), since the main app has no CSAM-review grant.
  Either removal's owner notice names the song or "the cover of your song" and links to the song.

Report song asks, whatever the reason, for a required "Time in the song" (m:ss), prefilled from the
playhead when the song is the current one and 0:00 otherwise, and editable. The report stores it as
`details.timestampSec` (whole seconds). The server (`assertSongReportTime`, on reports a user files)
refuses a song report with no time or a time past the song's stored length, a time on anything that is
not a song, and "Photorealistic depiction of a minor" on a song, which the form does not offer. With no
stored length, any time is taken. A sticker report on a song is about the placement and takes no time.
The song rules apply only for a reporter with the music feature who may open the song; otherwise the
report is treated as an image's, so a refusal never tells a hidden song from a hidden image. Scanner and
Knights reports are not checked and carry no time.

The image menu's Add to Showcase, art frame and event decorations, More like this, storylines, the
minor and POI flags, View Post and Edit Post are not offered on a song. The moderator design's "ToS
cover image" and "Remove from feed" have no action yet: a cover is removed from the moderator app's
song card (see Moderating songs).

## Moderating songs

In the moderator app (`apps/moderator`), songs have their own page, **Audio review**
(`/audio-review`, under Audio in the sidebar, with the number of reported songs, pending
appeals, held songs and covers decided there, and pending rating disputes). It is built on the shared triage shell: the queue on the left, the open song in the
middle, its reports, cover, checks, generation details and owner on the right with the decision bar
pinned under them. J/K move, number
keys decide, and a decided song dims and the next one opens. Desktop widths only.

- **Tabs:** Reported, Appeals, Held and Disputes.
- **Reported** lists songs with Pending reports (the reasons Image reports counts), one row per song:
  cover, title, how long it has waited, the most reported reason, the number of reporters and the
  owner. Sort by oldest, newest or most reports; chips for All, "Has a time" (a report with
  `details.timestampSec`) and "3+ reports"; search by title, owner or id.
- **The open song:** the song card in its `detail` form (player, then the lyrics at reading size,
  "Lyrics · click a line to seek"), and its length, genre, post, rating and remix setting. On the right:
  each report (reason, reporter, time in the song when it has one, the reporter's words); a report's
  time is a chip that plays the song from there, and each reported time is a red marker on the seek
  bar (hover names the reasons, a click on the dot above the track plays from it, and the thumb still
  drags across a marker; a report without a time has no chip or marker, and one at the stored length
  stays at the end when the file reads a little shorter). Above the bar each marker has a red time
  label, the first reading "Report at 1:24"; on a narrow bar the first shortens to its time and a
  label that would overlap the one before it is hidden (its marker keeps the hover). Under the player,
  "Jump to <first time>" plays from the first reported time and "Next report <time>" from the first
  one after the playhead, disabled after the last. A lyric line holding a reported time (the time
  falls between the line's start and the next timed line's) is tinted red with "Reported ×n", merged
  reporters counted. A chip, marker or button asks the song's card to
  play: a card whose file failed plays nothing, and a song that falls back to the stored copy starts
  there at the time asked for. Then the cover
  with its rating and scan state, the automated checks as states only (passed, held, blocked, not
  finished, failed), the generation details the song stored (model, seed, prompt, music description,
  lyrics source) and the owner (account age, removed songs, active strikes, other reported songs;
  the owner's counts leave out songs withheld from the moderator, as the lists do).
  The checks are "Audio scan" (the song's own verdict), "Lyrics scan" (a song with lyrics: held
  while a CSAM text hold is Pending, shown as not finished to a moderator who cannot open CSAM
  holds, else the lyrics' text moderation verdict) and "Cover scan". The
  Song card's Activity row has the song's all-time plays, Like reactions and comments, from the
  image metrics the site counts (ClickHouse, read for the open song only; left out when unread).
- **Decisions** (`image.moderate`, as on Image reports): 1 Dismiss reports closes the song's shown
  reports as Unactioned (Image reports' Unaction); 2 Remove song is Image reports' removal and asks for a
  violation type, closing the reports as Actioned; 4 Set rating opens PG to XXX (the next digit picks)
  and is a correction that leaves the reports open. 3 Remove cover removes only the song's own cover,
  with its own violation type: the song stays public with the placeholder, its reports stay open
  and the song stays open; the cover drops to the placeholder on the page without a reload. It is
  offered only while the song has its own cover that is not removed or withheld
  (`removableCoverId`, from `visibleSongLinks`), and is refused when the song has a new cover since
  the page loaded (the page posts the cover it showed). A removed song is ruled on as Image reports rules on a removed image: one blocked by an automated
  rule gets "Restore and dismiss" (it comes back up) and can be made a moderator removal; one a
  moderator removed only has its reports closed ("Close reports"); one removed for CSAM, or under
  CSAM review, takes nothing here.
- **A withheld song** (`withheldImageIds`) shows as "Withheld song #id", with no title, audio, lyrics,
  cover, owner, rating or report text, and no decisions; it links to the CSAM image queue
  (`/images/csam`), where media withheld by that rule is decided. Search finds it only
  by its exact id, and it counts for no "Has a time" chip. A cover's file is sent only when the
  public player would show it and it is not withheld.
- **Appeals** lists owners' Pending appeals of a removed song or of a song's removed cover (an image
  flagged for appeal that is a song or a song's own cover, `songAppealImages`), one row per appeal:
  "Song appeal" or "Cover appeal", the removal's violation, "Repeat ×n" from the second appeal on the
  same image, and the owner. Chips for All, Song and Cover; sort by oldest or newest. The open
  appeal shows the owner's words, the removal (who removed it, when, the violation) and the song's
  side cards; a song appeal has the player and lyrics (a removed song plays from storage), a cover
  appeal the removed cover and its "Cover of song" link. 1 Approve appeal and 2 Reject appeal
  (`image.moderate`) take a reason, an optional note and an optional message to the owner, and go
  through the image appeal resolver (`resolveImageAppeal`), so approving restores only the image
  appealed: a cover's approval leaves its song alone, and the reverse. There is no rating to apply
  on restore: the resolver lifts the removal and rescans an unrated image, and a moderator rates it
  afterwards. A withheld appeal shows no media, owner, words or removal and takes no decision.
- **Held** lists three kinds of held song, one row per song (chips All, Lyrics, Cover, Song; sort
  by oldest or newest; search by title, owner or id; `owner=<userId>` lists one owner's rows, shown as
  a removable "Owner:" chip, and like a text search never matches a lyrics hold or a withheld row).
  The open song's owner card adds "Other held": the owner's other rows that filter lists, by kind
  ("1 song, 2 covers"), with View linking to it; it is read on this tab only. Status Pending (the
  default, and the tab's badge), Resolved or All: each decision on this tab (Approve cover or song,
  Remove cover or song, not one held for a second moderator) writes a `ModActivity` row
  `audioHeldDecision` with `details` `{ decision, kind, flag, songId, coverId }`, beside the writers'
  own `review` rows, and Resolved lists each song at its last such decision unless it is held again:
  what was decided, by whom, when and the flag, read-only with no keys. A decided song or cover
  withheld from the moderator shows only its id. Decisions made before that column existed are not
  listed:
  - **Lyrics held:** the song's lyrics are under a Pending CSAM text hold (`TrackLyrics`). The row
    shows "Withheld song #id", "Song withheld" and when it was held, with no audio, cover, lyrics,
    title or owner for anyone on this page, whatever their grants; search finds it only by its exact
    id. Its one key, 1 Open in CSAM holds, links to the hold in `/csam/text-holds`, and is enabled
    only for a moderator who can open that page and holds `csam.report.file` (the grant its load
    demands); otherwise it is disabled with "You don't have access to CSAM holds. Ask a team lead
    for the grant." Nothing is decided here.
  - **Cover flagged:** the song's own cover carries a review flag of the image review queues
    (minor, POI, tag, new user, moderation rule, remix source). The open row shows the cover under
    review, then the song card and the side cards. 1 Approve cover clears only the cover's flag
    through the review queues' accept writer, on the cover's row alone (the song is untouched, and
    the cover goes public once nothing else holds it); 2 Remove cover and 3 Remove song take a
    violation type; 4 Set rating rates the song. The page posts the cover and the flag it showed, and
    a cover replaced since (even by one flagged the same), one whose flag changed, or one under the
    CSAM flag, is refused.
  - **Song flagged:** the song itself carries one of those flags (a moderation rule's Hold can set
    `modRule` on a song). 1 Approve song clears it the same way, then 2 Remove song, 3 Remove cover
    and 4 Set rating as on the Reported tab.
  A song under a lyrics hold is listed only as that hold, and a flagged song only once, even when its
  cover is flagged too (the cover row appears once the song's flag is decided). A flagged cover or
  song withheld from the moderator (`withheldImageIds`) carries only its id and kind, and takes no
  decision. Every decision needs `image.moderate`. The sidebar badge counts the flagged songs and
  covers decided here, not lyrics holds, which CSAM holds counts; the tab's own count includes them.
- **Disputes** lists owners' rating disputes on songs (`RatingReview` entity type `Song`, see
  "Rating disputes" below), one row per dispute: the level the owner saw and the level they ask
  for, "Repeat ×n" from the second dispute on the same song, and the owner with whether they
  commented. Status Pending (the default, and the tab's badge), Resolved or All: a resolved row shows
  Approved or Rejected and its ruling read-only, and takes no key (a resolved dispute on a withheld
  song reads only "Resolved"). Chips for All, Asks lower and Asks
  higher; sort by oldest or newest; search by title, owner, the song's id or the dispute's;
  `owner=<userId>` lists one owner's disputes (never one on a withheld song). The open dispute has
  "by <owner> · disputed <age> ago · <nth> dispute" under its title, an "Owner's disputes" link
  (that owner, every status), the song card (player and lyrics), its facts, three level cards
  (Current, Owner asks, and Scan default: PG, the level a song's own scans give every clean song,
  which nothing stores per song), the owner's comment, "This dispute" (when it was filed, its
  ruling once resolved, and the last ruling on a dispute of the song filed before it: "Ruled Oct 30:
  kept PG-13"), "Current rating" (set by its scans while unlocked, else the moderator of the latest
  `setNsfwLevel` row whose `details` `{ from, to }` changed the level, with when and the level
  before it (`from`); a write that kept the level, such as a keep ruling, credits no one, and a row
  from before `details` existed reads "Last rated by" with the level before "Not recorded") and the song's side cards, whose owner card adds "Rating disputes" (the owner's song
  disputes by outcome). The tallies and the rating card are read on this tab only, for the open song. Keys 1 to 5 pick PG to XXX, then a
  note and Enter apply it, as on `/ratings` (the same decision form): applying the owner's ask
  approves the dispute, any other level rejects it, and keeping the current level needs a reason.
  The ruling goes through the moderator rating-review resolver (`resolveRatingReview`, with
  `songs: true`), which writes the level to the song and tells the owner (see "Rating disputes").
  A song its scans have not reviewed yet shows that and takes no level; one that can never be
  reviewed says so, and any level closes its dispute with nothing applied. A dispute on a song
  withheld from the moderator shows only the ids and the wait, takes no decision and links to the
  CSAM image queue. Every decision needs `image.moderate`.
- **The image review queues** (`/images/minor`, `/images/poi`, `/images/tag` and the rest, not the
  CSAM queue) and their badges leave out songs and songs' own covers under those flags
  (`onHeldTabText`), since the Held tab decides each of them. The one case it does not take stays
  there: the flagged cover of a song under a lyrics hold. The CSAM queue keeps songs and covers.
- **Image reports** lists images and videos only, and its badge leaves songs out. The image Appeals
  queue (`/images/appeals`) and its badge leave out the Pending appeals of songs and their own covers,
  which Audio review's Appeals tab decides, so an appeal is decided in one place. A song or cover still flagged for appeal with no
  Pending appeal stays in the image Appeals queue, whose decision clears the flag. On a help-desk
  ticket a song or cover appeal is listed as "Song or cover" under the Audio review page grant, with
  a link to it there instead of a ruling.
- **List thumbnails** follow the cover card's rule: a cover withheld from the moderator is not sent
  for a Reported or Appeals row either.
- **Minor and POI** are not offered on a song in the image queues, and `setImageFlag` refuses to set
  either on a song, whichever page asks; clearing one still works.

The song card (`SongCard.svelte`) also renders in the image review queues, Image lookup and
Removed-appeals, marked "Song": its cover, a play/pause button, a seek bar with the time, a volume
control, the title, and the lyrics in a scrollable panel. A lyric line with a time plays the song from
there; a line without one is text. Image and video cards are unchanged.

- **Playback** (`$lib/music/song-player.ts`): nothing plays until the moderator clicks, one song plays
  at a time across the page, and each song starts at the last volume chosen (kept in this browser's
  localStorage). `playSongAt(imageId, seconds, cardKey?)` starts a card's song at a time from
  anywhere on the page; `cardKey` is the grid's item key, for a song shown on more than one card.
- **A removed song** plays from storage through `/api/retracted-media`, which serves only a signed-in
  moderator, as audio (`heldMediaContentType` names the audio types); the public CDN refuses it to
  everyone else. From storage nothing loads until play, since every response there is an audit row.
- **Cover, title and lyrics** come from `/api/song-card/[imageId]` (`song-card.service.ts`). The cover
  shows only as the public player would show it (one rule, `isPlayerSongCover` and its SQL form in
  `@civitai/db-queries/profile-picture-clear`, which `getSongCoversForPlayer` uses too): the owner's own image
  outside any post, scanned, with no block marker, not held for review and not flagged as a minor;
  any other is the placeholder. A song withheld from the moderator is refused, lyrics included.
- **Rating** a song is allowed once its own scans have reviewed it (`ingestion` Scanned). Before that
  the rating is refused, under that card's rating chips (in Audio review, in the page's banner), with "This song has not been reviewed yet", since a locked level would count
  as the song's review (#10162); a removed song is refused with "This song was removed, so it can't
  be rated." A rated song is locked, and `imageReviewedSql` counts a lock as a review, so nothing may
  return a rated song to Pending, Error or Rescan without clearing its lock.
- **Removing a song or its cover** are two actions, each with the usual violation type and notes:
  Audio review's keys 2 and 3, and on a song card in the review queues "Remove song" and, while the
  song has a cover to remove, "Remove cover" (`cardRemovals` in `$lib/music/song-tos.ts`). Both are
  `blockImage` on their own row. Removing the cover leaves the
  song public, and the player shows the placeholder (a blocked cover fails `isPlayerSongCover`);
  removing the song leaves the cover alone (decided by the moderation lead). "Remove song" actions
  the song's reports and "Remove cover" leaves them open. Each removal records its own
  violation type, notifies the owner ("Your song "<title>" has been removed …", "The cover of your
  song "<title>" has been removed …", both linking to the song: `songNoticeSubject`, and the
  `tos-violation` template's `song` / `song cover` wording), and is appealed on its own, per image
  row (Appeals tab).
- **A cover in an image queue** carries "Cover of song <title>", linking to the song in Image lookup.
  Song and cover are linked only through the song's own cover (`songsOwnCoverText`), read by
  `getSongLinks` (`song-links.service.ts`) for every queue card. A link to a song or cover withheld
  from the moderator is left off, and a failed read leaves the cards without links. A removed cover
  drops to the placeholder on every song card on the page at once.
- **Removed-appeals** shows the song card for an appeal on a song still on file, unless the song is
  withheld from the moderator (`withheldImageIds`), which shows the refusal line instead; other rows
  stay text only. An appeal whose song row is gone has nothing to play.
- **Text holds** (`/csam/text-holds`): a lyrics hold (`TrackLyrics`, whose entity id is the song's
  Image id) shows as "Song lyrics", titled with the song's title, with the held text and the song
  card, or the refusal line for a song withheld from the moderator. When the song or its withheld
  check cannot be read, the detail says "Couldn't load this song. Reload before deciding." and the
  decisions stay available. Remove, strike and ban are offered as on a post hold; "Remove"
  unpublishes the post that contains the song. Dismiss releases the song, so it is back on the site
  and in search. The decisions are the main app's (`csam-hold-decision.ts`).

## Rating disputes

A song's owner disputes its rating from the song menu's Dispute rating, which opens the shared
rating-dispute modal (`RatingReviewModal`). The dispute is a `RatingReview` row of entity type `Song`
whose `entityId` is the song's `Image` id, so a plain image is never disputable. Filing follows the
shared rules in `docs/features/rating-dispute.md` (owner only, one pending per song, 3 a day), needs
the `music` flag beside `ratingDispute`, and no text scan: the current level is the song's
`nsfwLevel`. A song its own scans have not reviewed yet (`ingestion` other than `Scanned`), a removed
one, or one whose scan gave up (`songNeverReviewable` in `@civitai/shared/rating-review`: the ingest cron's
retry ceilings, under the failure class the cron itself resolves, `effectiveScanFailureClass`)
cannot be disputed, each with its own message. A dispute closed with nothing applied does not stop
the owner filing again once a rescan has reviewed the song.

Moderators decide song disputes on Audio review's Disputes tab only (`/ratings`, its badge and
tickets leave songs out; see "Moderating songs"): the resolver refuses a song dispute from any other
caller, and refuses anything else from that tab. A ruling goes through the moderator rating writer
(`writeImageNsfwLevel`, on the ruling's own transaction, with each of its cache, activity and search
steps run after commit, a failing one not skipping the rest): it sets and locks the song's level, and since a locked level counts as the
song's review, it is refused, with nothing written, while the song's scans are running or due a retry,
which the write re-checks. A song that can never be reviewed (removed, its file gone, or its scan past
its retry ceiling) closes its dispute as a deleted entity's closes: nothing applied, no notification. The owner's notification names the song ("your song "<title>"") and links its page.

## After launch

- **A music section on the profile overview.** The profile's Music tab lists a creator's songs; a
  section creators can place on their overview waits until after launch (decided 2026-11-20).
