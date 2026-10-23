# Storylines

A storyline is a branching visual story told in posts. Each chapter is an ordinary post. The person
who starts the storyline writes the main path; other creators can continue it from the end of any
chapter, so a story grows into a tree of alternatives that readers walk through and choose between.

**Status:** behind the `storylines` feature flag. Flipt decides who sees it; if Flipt is unreachable or
the flag is missing there, it falls back to moderators and users granted the `storylines` permission.
This page describes what is built; the in-app tool for making the next section is not (see the last
section).

## For readers

- **Finding one.** An image that belongs to a storyline carries a storyline pill in the images feed and
  in image detail. Opening it enters storyline mode.
- **Reading.** In storyline mode, left and right in image detail walk the chapter's images and then
  move on to the next chapter, instead of paging the feed. A chip on the image says which storyline
  and chapter you are in and opens the map; Leave the storyline at the bottom of the map returns you
  to browsing that post's images.
- **Where am I.** The chip opens a map of the storyline, a sheet that drops from the chip (a bottom
  sheet on a phone) while the image stays visible: the main path as a timeline, the forks off it, and
  how readers have split at each fork, from the first recorded choice. Any chapter on the map can be
  jumped to.
- **End of a chapter.** At the end of a chapter the reader picks how to continue. Each way on shows
  its first image and its share of readers. The main path is shown first and largest, with Read as
  the main action, then continuations by the storyline's endorsed collaborators, then everyone
  else's, ordered by how many readers took them. Writing a continuation sits below.
- **Where branches meet.** Two branches can rejoin at one chapter. The reader's path and chapter
  numbers follow the way they came (the URL carries it, so a shared link reproduces the route), and
  the chip's map marks a chapter where another branch joins (the page's chapters list draws it too).
- **Chapters list.** The storyline page lists the main path down the left with large tiles and
  titles. Once a story forks, every other branch runs in a coloured lane beside it, with a labelled
  band where the story forks and where a branch joins back. Any chapter opens in storyline mode over
  the page, along the route the list draws to it. It shows the first 300 chapters, nearest the start;
  a chapter the reader cannot see is a placeholder that does not open.
- **Continuing it.** At the end of a chapter a reader can submit a post they already made as the next
  chapter ("Use a post you made"), for the storyline's price in Buzz or free. It goes to the creator's
  review unless the reader is an endorsed collaborator. A storyline that is closed or open only to
  collaborators says so instead. The in-app tool for making the next section is not built yet:
  "Create the next section" joins an early-access list.
- **Content level.** Every storyline has a maximum content level set by its creator. A chapter above
  it is shown only as a placeholder, without its images, so the chapters after it stay reachable.
  The same goes for a chapter whose post was removed or whose author was banned. Each reader's own
  browsing level still applies chapter by chapter.
- **Titles.** A storyline's title is checked automatically. The check can raise the story's rating or
  take it down. A storyline flagged for a minor stays up but can only hold safe-for-work chapters,
  forks included: anything above is a placeholder, and new chapters above it are refused. Editing the
  title has it checked again.
- **Captions.** Each image of a chapter can carry its author's caption, shown as a note at
  the bottom of the image; tapping it opens the rest. Once its text check is rolled out, a caption is
  checked like a title: one the check refuses is not shown, and one rated above the storyline's
  maximum or the reader's browsing level is hidden for that reader.
- **Reporting.** The menu on a storyline's page reports the storyline itself, such as its title, to
  moderators. A chapter is reported as its post or image.

## For creators

- **Starting one.** A published post becomes the first chapter of a new storyline.
- **Settings.** Status (ongoing or complete), who may continue it, the maximum content level, and the
  price, if any, to submit a continuation.
- **Collaborators.** The creator can endorse collaborators. Their continuations are added without
  review and are listed ahead of other contributors' at the end of a chapter.
- **Review.** Continuations from anyone else wait in the creator's review queue to be approved or
  declined. A post above the storyline's content level cannot be submitted at all. A post submitted
  while still a draft or still being scanned reaches the queue once it is published and rated, or is
  withdrawn then if it turns out above the content level.
- **Price and refunds.** A priced continuation's Buzz is held when it is submitted. If the creator
  declines it they keep a share as a decline fee and the rest is returned. It is refunded in full if
  it is withdrawn, if nobody answers in time, or if it can no longer be accepted (its parent chapter
  was removed or the storyline was taken down). A submission whose payment never completed is settled
  by a sweep.
- **Appeals.** When the title check takes a storyline down, its creator sees a notice on the
  storyline's page and can ask for a review. Moderators rule on it under Storylines > Title Appeals
  in the moderator app: granting brings the storyline back and stops a recheck of the same title from
  taking it down again; denying leaves it down, and the creator can ask again. A grant is refused if
  the title was edited after the moderator saw it. A storyline a moderator took down cannot be
  appealed this way. A moderator who lifts the takedown directly, without a review, also approves
  an open appeal of it, recorded as a direct lift and not a reviewed appeal; if a moderator's own
  takedown still holds the storyline down, the appeal stays open.
- **Rejoining branches.** The creator can bring two branches back together at the end of a
  chapter: "Add the next chapter", then "Join an existing chapter", offers a chapter already in the
  story as a way on. Nothing is copied. A link that would loop, skip chapters on a
  route, or lead into the first chapter is refused, and a chapter can be joined from at most 8
  chapters. The picker offers the 100 chapters nearest the chapter being continued, and only ones the
  storyline's owner is shown. Before rolling back the rejoin code, remove the second and later
  parent links of any chapter that has more than one parent, keeping each chapter's oldest.
- **Credit.** A continuation can fork from the end of any chapter. Earlier chapters are referenced and
  credited to their authors, never copied.

## Not in the first version

An in-app tool for making the next section, a way for authors to write image captions (the server
side is built), and deleting a storyline: its creator
marks it complete instead, and moderators take down one that breaks the rules.

## Trying it locally

`scripts/storylines/storylines-demo-seed.sql` builds a demo storyline, "The Patch", from posts two dev
accounts already have; `storylines-demo-cleanup.sql` removes it. Both refuse to run anywhere but a
development database. `storylines-demo-seed.selftest.mjs` checks them against throwaway Postgres
servers; its header has the commands.
