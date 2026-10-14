# Storylines

A storyline is a branching visual story told in posts. Each chapter is an ordinary post. The person
who starts the storyline writes the main path; other creators can continue it from the end of any
chapter, so a story grows into a tree of alternatives that readers walk through and choose between.

In development behind the `storylines` feature flag (moderators and individually granted users).

## For readers

- **Finding one.** An image that belongs to a storyline carries a storyline pill in the images feed and
  in image detail. Opening it enters storyline mode.
- **Reading.** In storyline mode, left and right in image detail walk the chapter's images and then
  move on to the next chapter, instead of paging the feed. A banner says which storyline you are in;
  leaving returns you to where you were in the feed.
- **Where am I.** The pill opens a map of the storyline: the main path as a timeline, the forks off it,
  and how readers have split at each fork once enough of them have chosen. Any chapter on the map can
  be jumped to. On mobile the map is full screen.
- **End of a chapter.** At the end of a chapter the reader picks how to continue. The main path is
  shown first and largest, then continuations by the storyline's endorsed collaborators, then
  everyone else's, ordered by how many readers took them.
- **Creating the next section.** A reader can ask to make their own continuation. Until that tool
  ships, this joins an early-access list.
- **Content level.** Every storyline has a maximum content level set by its creator. Chapters above
  it are not shown in the storyline. Each reader's own browsing level still applies chapter by
  chapter, and a chapter a reader cannot see is shown as a placeholder so the path still reads end to
  end. The same applies to a chapter whose post was removed: the chapters after it stay reachable.

## For creators

- **Starting one.** A published post becomes the first chapter of a new storyline.
- **Settings.** Status (ongoing or complete), who may continue it, and the maximum content level.
- **Collaborators.** The creator can endorse collaborators. Their continuations are added without
  review and are listed ahead of other contributors' at the end of a chapter.
- **Review.** Continuations from anyone else wait in the creator's review queue to be approved or
  declined. A post above the storyline's content level cannot be submitted at all.
- **Credit.** A continuation can fork from the end of any chapter. Earlier chapters are referenced and
  credited to their authors, never copied.

## Shape of the data

A storyline owns a set of chapters, one per post. The tree is held as edges from a chapter to its
parent, separate from the chapters, so a chapter could later gain a second parent (two branches
rejoining) without reshaping existing data; for now each chapter has one. At most one child of each
chapter is marked as the main path. Whether a continuation counts as endorsed is not stored on it:
it follows the current collaborator list, so endorsing someone also reorders the chapters they have
already added.

## Not in the first version

Branches rejoining, an in-app tool for making the next section, and paid continuations.

## Trying it locally

`scripts/storylines/storylines-demo-seed.sql` builds a demo storyline, "The Patch", from posts two dev
accounts already have; `storylines-demo-cleanup.sql` removes it. Both refuse to run anywhere but a
development database. `storylines-demo-seed.selftest.mjs` checks them against throwaway Postgres
servers; its header has the commands.
