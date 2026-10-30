# Reusable Text Blurbs

**Status**: Built, behind a feature flag (off by default)
**Tracking**: CU 868kv243c

A creator writes a piece of text once, gives it a name, and drops it into any supported rich text
editor by reference. **Editing that text updates every place it is used, automatically.**

The problem it solves is maintenance, not authoring. A creator with a donation link in the footer
of forty models, or a recommended-settings block across every resource they publish, previously had
to edit forty pages by hand or let the text go stale.

## Vocabulary

Everything a creator reads says **Snippet** — the toolbar control, the manager, the picker, every
error message. Everything in the codebase says **blurb**. They are the same object; the rename was
UI-only.

---

## Creating and managing snippets

Snippets are managed from a modal opened by the editor's toolbar — there is no separate page. It
lists a creator's snippets and handles create, edit, insert and delete.

A snippet has a **name** and a **body**. The name is set once at creation and cannot be changed
afterwards; to fix a typo, delete and recreate. Names must be unique per creator among their live
snippets.

Snippets are private to their creator. There is no sharing, no team scope and no public snippet.

The manager does not show usage counts. Editing tells the creator the change is not local, without
naming a number.

## Inserting a snippet

Two entry points, both inside the rich text editor:

- the **toolbar control**
- typing **`//`** inline, which opens a picker. Two slashes rather than one because a lone slash is
  common in prose; the trigger only fires at the start of input or after whitespace, so `https://`
  does not open it.

An inserted snippet appears as a **chip** showing the snippet's name, not its words. The chip is a
single unit: it cannot be edited in place, and formatting controls do not apply to it. Both exist so
one copy cannot silently drift from the snippet it came from — change the words in the manager and
every copy follows.

A chip whose snippet no longer exists renders as **orphaned**. Its words are still there and still
published; only the link back is gone.

## What a snippet can contain

A snippet holds formatted text: headings, paragraphs, bold, italic, underline, strikethrough,
inline code, links, bullet and numbered lists, line breaks, and text colour.

It cannot hold images or video, blockquotes, code blocks, or another snippet.

---

## What happens when a snippet changes

**Editing** a snippet does not rewrite anything immediately. A background pass picks up the affected
content and rewrites it, normally within a few minutes. A large fan-out drains over several passes
rather than all at once, so a creator with hundreds of pages sees them update progressively.

Each rewrite is an ordinary edit to that piece of content, so everything that normally follows an
edit follows this one: the moderation scan, the search index sync, and cache invalidation. Link
domains are re-checked against the blocklist, since it can move after a snippet was written.

One thing a rewrite deliberately does **not** do is bump the content's "last updated" timestamp. A
snippet update is not a creator edit, so it does not reorder recently-updated feeds or reopen
edit windows keyed on that timestamp.

**Deleting** a snippet removes it from the picker immediately. Existing uses are then rewritten in
the background, each chip replaced by the words it was showing, as ordinary text.

Published content never breaks because a snippet changed or went away. The words are stored in the
content itself, not fetched at render time — so the API, search, RSS and the page all keep working
regardless of what happens to the snippet afterwards, and disabling the feature entirely leaves
every page reading exactly as it did.

---

## Where snippets work

Enabled: **model descriptions**, **model version descriptions**, **articles**, **bounties**, and
**cosmetic shop items**.

Not enabled, each for a reason rather than for effort:

| Surface | Why not |
|---|---|
| Challenges | A description change puts the challenge back into ingestion, which hides a live one from the feed. A background rewrite would take a running challenge down. |
| Changelogs | They have no author, so a snippet in one has no owner to resolve against. |
| Comments and reviews | The highest-volume surfaces in the app. One snippet edit reaching thousands of comment rows is a different risk profile, and is worth revisiting only after the feature has run at a smaller scale. |

## Moderation

**A snippet is not a moderated object.** It has no rating, no audit status and no review queue, and
nothing routes one anywhere for review.

Moderation happens on the content the snippet lands in. When a page is saved or rewritten, the whole
page — snippet text included, in context — goes through that surface's normal scan. That is stronger
than scanning a snippet alone would be, since the concern is usually how the text reads alongside
what surrounds it.

The one check that does run against a snippet directly is the blocked-link-domain check, on create
and on update.

---

## Limits

| Limit | Value |
|---|---|
| Snippets per creator | 20 |
| Snippet length | 3,000 characters |
| Snippet name | 60 characters |
| Places one snippet may be used | no limit |

The first and last move together. With no ceiling on how far a single snippet reaches, the way to
bound a creator's total footprint is to bound how many snippets they keep — so the per-creator limit
is tighter than it would otherwise be.

## Availability

Off by default, behind a feature flag, and currently limited to moderators. The background rewrite
pass is **not** gated: a creator who leaves a rollout keeps their existing snippets maintained
rather than stranded.

🔴 **Ramp the flag by percentage or boolean only.** It is evaluated against the content owner rather
than the person making the request, so a segment-based rollout matches nobody and looks exactly like
"snippets are off".

Because a snippet edit has no upper bound on how many pages it rewrites, watch the rewrite volume as
the flag ramps rather than after.

---

## Not supported yet

- Comments and reviews as surfaces.
- Sharing a snippet between creators, or team-level snippets.
- A dedicated management page, and whether it belongs in Creator Studio.
- A snippet that renders differently depending on where it is used.
- Snippets in the generator prompt editor — it already has snippet categories.
