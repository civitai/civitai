# Reusable Text Blurbs

**Status**: Built, behind `FLIPT_FEATURE_FLAGS.TEXT_BLURBS` (default off) and `featureFlags.textBlurbs` (`availability: ['mod']`)
**Tracking**: CU 868kv243c
**Last Updated**: 2026-08-25

⚠️ **As of 2026-08-25 the migration is committed and has not been applied in any
environment.** `packages/civitai-db-schema/prisma/migrations/20260825000000_add_blurbs/migration.sql`
— nothing here works until a human runs it; migrations in this repo are never auto-applied
(CLAUDE.md → Database). See "What is not done" at the end.

A creator defines named blurbs of text once and drops them into any rich text editor by
reference. **Editing the blurb updates every place it is used, automatically.**

That sentence is where all of this proposal's cost lives: a blurb edit becomes a write to every
entity referencing it. A cheaper version that only pastes text on insert was considered and
rejected, because the problem reported was maintenance rather than authoring — a paste leaves
the creator updating forty pages by hand, which is the thing they asked us to fix.

A creator-triggered variant was also considered, where a blurb edit marked its uses out of date
and the creator pressed an action to apply them. Rejected in review: the update should just
happen.

This records the decisions, not the code.

---

## The problem

Maintenance, not authoring. A creator with a donation link in the footer of forty models, or a
recommended-settings block across every Flux resource they publish, has no way to change that
text once. They edit forty pages by hand, or the text goes stale.

The feature only earns its place if a later edit reaches content that is already published.

---

## How a blurb is stored

**A blurb reference and its expanded text are stored together, in the same span.**

```html
<p>Trained on Flux.</p>
<span data-type="blurb" data-id="7">Tip me: ko-fi.com/example</span>
```

The reference is what a later edit finds. The text is what everything else reads. Both live in
the entity's own content column — `Article.content`, `Model.description`, and so on. No column
is added to any existing table.

Two consequences follow, and they are the reason for the design:

**Every consumer keeps working with no changes.** The stored column is the public artifact: the
REST API returns `description` verbatim, the Meilisearch document indexes it, RSS and SSR read
it, and `<RenderHtml html={...} />` renders it. A reference that carried no text would render as
an empty span in all of them, because none of those consumers can call a resolver. Storing the
text means the API and the search index need no knowledge of blurbs at all.

The render path has one exception, found in the build: `RenderRichText` (the article detail page)
parses the HTML back into a ProseMirror document, so it needs `BlurbNode` registered and a node
mapping — the static renderer's default emits `node.attrs.text` as an escaped text child, so a
blurb's bold/italic/link markup would render as literal tags. That mapping re-applies
`sanitizeBlurbInterior` before injecting it, because the fan-out writes bodies via raw SQL rather
than through zod, so this is the pass that makes it safe rather than an assumed upstream one.
`RenderHtml` surfaces (model, version, bounty, shop) need nothing: they strip `data-type`/`data-id`
off the span at render — they do not pass `allowBlurbs` — and the words render as ordinary inline
markup.

**A blurb edit becomes an ordinary entity edit.** Because the text lives in the column, changing
a blurb means writing that column — which means going through the entity's normal update
function, which means everything hanging off that function fires: its moderation scan, its
search-index sync, its cache invalidation. None of that has to be rebuilt for blurbs. This is
what keeps the feature small.

It also degrades well. Delete every blurb, revert the feature, drop the table — the text is still
sitting in the content. The span's `data-*` attributes are stripped at the next save and at render,
leaving the words as plain inline markup.

### Why not resolve at render time

The alternative — store `data-id` alone, expand when React renders — is what makes the feature
expensive rather than cheap, in three ways.

It leaves the words out of the stored column, so every non-React consumer above shows nothing.

It gives a blurb edit no entity write to hang anything on, so re-moderation, index sync and
cache invalidation all become new machinery rather than inherited behaviour.

And it defeats the deduplication that protects the moderation pipeline from redundant work.
Scan requests are deduplicated on a hash of the submitted text (`orchestrator.service.ts:452`),
and the retry cron re-derives that text from the stored column
(`article-moderation.adapter.ts:15`). If a blurb edit does not change the column, both read the
old text, both hash the same, and both conclude the entity was already checked — while the page
renders something else. Storing the text keeps the hash honest.

---

## Where references are tracked

```prisma
model Blurb {
  id          Int      @id @default(autoincrement())
  userId      Int
  user        User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  name        String   @db.Citext
  content     String
  contentHash String
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  deletedAt   DateTime?

  references BlurbReference[]

  @@unique([userId, name])
  @@index([updatedAt])
}

model BlurbReference {
  blurbId          Int
  blurb            Blurb    @relation(fields: [blurbId], references: [id], onDelete: Cascade)
  entityType       String
  entityId         Int
  materializedHash String
  materializedAt   DateTime

  @@id([blurbId, entityType, entityId])
  @@index([entityType, entityId])
  @@index([materializedAt])
}
```

`name` is `@db.Citext` and unique per owner, matching `WildcardSet` and giving the composite
constraint the team settled on in discussion. `entityType` is a `String`, not an enum, so
adding a surface later is a code change rather than an `ALTER TYPE` with the deploy-ordering
rule that comes with it.

`BlurbReference` is reconciled on every save of a referencing entity — not derived by scanning
content, which would need a full-table read per blurb edit.

### Staleness is derived from the content, not from the row

Staleness is never stored. A reference is stale when the text it holds is not the text the
blurb now says:

```sql
WHERE r."materializedHash" <> b."contentHash"
```

**The hash, not `updatedAt`, is deliberate.** Clocking off the row's modification time would
mean every column added to `Blurb` later becomes a trigger: an `archivedAt`, a description, a
visibility flag — each one would bump `updatedAt` without the text changing, and fan out a
rewrite plus a re-scan of every referencing entity with byte-identical content. That is a
constraint no schema can carry safely, because the person who breaks it is someone adding a
field years from now who never reads this file.

Hashing the content removes the constraint instead of documenting it. Only `content` feeds the
hash, so no field anyone adds can make a reference go stale.

⚠️ **It is not self-enforcing at the database level.** `contentHash` is a plain column with no
trigger and no generated expression — `hashContent(content)` runs in `blurb.service.ts` and nowhere
else. A raw SQL backfill or admin script that changes `Blurb.content` without recomputing the hash
leaves every reference looking fresh and the fan-out silently skipping it. Anything touching
`Blurb.content` must write `contentHash` in the same statement.

Reuse `hashContent` (`entity-moderation.service.ts`) rather than adding a second hashing
helper.

Two layers do the work, the second protecting the first:

| Layer | Job | Cost when it is wrong |
|---|---|---|
| hash comparison in the selector | decide staleness | exact |
| no-op guard in the writer | span already correct → skip | one read, never a write or a scan |

**The `updatedAt > lastRun` watermark this design started with was dropped.** It was Justin's
suggestion — find blurbs touched since the last run via `getJobDate`, then look at their references
— and once staleness became hash-derived it bought nothing: the hash join is exact and indexed, and
a watermark can only lose work when a run is missed. Nothing reads `getJobDate` for this job, and
`Blurb.@@index([updatedAt])` is consequently read by nothing today.

It is self-healing with no queue state to reconcile. A reference whose hash does not match
is stale, whatever went wrong before, so a crashed or half-finished run needs no recovery logic.
It is simply picked up next pass.

`materializedAt` orders the fan-out's selection window, and a failing row is bumped to the back of
it rather than heading the queue again next pass — that bounds a permanently-failing row to one
selected slot per pass once the backlog exceeds the batch limit. It does **not** reduce how often
that row is retried: with the whole backlog inside one batch (the common case) every stale row is
selected on every run regardless of position. It is also what makes backlog age measurable.

**Names cannot be changed.** Not for any mechanical reason — the markup carries `data-id`, and
with hash-derived staleness a rename provably fans out nothing. It is a product call: a blurb's
name is how a creator refers to it, and a stable one is worth more than the ability to fix a
typo in a list of at most twenty. Revisit if a creator asks.

---

## The save path

`getSanitizedStringSchema` (`src/server/schema/utils.schema.ts:5`) is the single chokepoint —
one zod preprocessor used by every rich-text schema, article and model and version and the
rest. Blurb handling attaches in two layers, because that preprocessor has neither database
access nor the acting user.

**At the schema layer**, a blurb span's `data-type`/`data-id` are stripped unless the surface passed
`allowBlurbs`. It exists for the same reason as the sticker strip in `html-sanitize-helpers.ts` —
`span` and its `data-*` attributes are already in `DEFAULT_ALLOWED_ATTRIBUTES`, so blurb markup
would otherwise survive on *every* rich-text surface, and the fan-out would then rewrite content on
a surface nobody registered. The mechanism differs from the sticker strip, though: that one drops
the whole element via `exclusiveFilter`, while this removes only the two attributes via a
`transformTags.span` composed **after** the caller's spread, so a caller-supplied span transform
cannot reinstate them. The span and its words survive; only the reference does not. Default-deny
means a surface added later fails closed.

⚠️ `allowBlurbs` is an attribute **strip** toggle, not a tag admission. A schema that narrows
`allowedTags` below the app default has to admit `span` itself — `modelVersionUpsertSchema` did not,
and without that the span is stripped at save, `expandBlurbs` sees plain text, and the control
renders and silently does nothing on that surface alone.

**At the service layer**, each opted-in upsert calls two functions in
`blurb-materialize.service.ts`. This design called them one function, `materializeBlurbs`; they were
split because expansion must happen before the write and reconciliation after it.

1. `expandBlurbs({ userId, html, restrictToBlurbIds })` — resolves each `data-id` against the
   owner's rows, replaces the span's inner content with the row's current text, and unwraps to
   plain text any span it may not resolve.
2. `reconcileBlurbReferences({ entityType, entityId, uses })` — reconciles this entity's
   `BlurbReference` rows against the spans that survived.

Step 1 is a security requirement, not an optimisation. The inner text arrives from the client and
cannot be trusted: a hand-crafted request could claim blurb 7 says anything at all, or reference a
blurb belonging to somebody else. The server re-expands from the row on every save, so what is
stored is always what the owner's blurb actually says.

**`expandBlurbs` is keyed on the content's OWNER, not the acting user.** Keying on the actor would
mean a moderator saving someone else's model resolves none of that creator's blurbs and strips every
span out of the body. The obvious hole that opens is closed by `restrictToBlurbIds`: a non-owner may
keep the ids the entity already references (`getReferencedBlurbIds`) and nothing else, so a
`data-id` they invent resolves to nothing rather than splicing a stranger's private blurb text into
a response they read back.

🔴 **`expandBlurbs` returns a discriminated union and both arms are load-bearing.**
`{ evaluated: true; html; uses }` when the flag resolved for that owner, `{ evaluated: false; html }`
when it did not. Both leave the html alone, but only the first means the entity's references should
be reconciled — so every call site gates `reconcileBlurbReferences` on `expansion.evaluated`.
Reconciling on the false arm deletes every reference row the moment a creator falls out of the
rollout, and the fan-out then has nothing left to maintain.

---

## The fan-out

Saving a blurb writes one row. A job does the rest.

```
save blurb 7
  |
  +-- write the Blurb row  (content + contentHash)
  |
  v   nothing else happens synchronously

blurb-fanout job   (*/5 * * * *, lockExpiration 15m)
  |
  +-- stale references: JOIN Blurb ON materializedHash <> contentHash OR deletedAt IS NOT NULL
  |     AND entityType = ANY(<registered adapter keys>)  ORDER BY materializedAt ASC  LIMIT 500
  |
  +-- for each, through limitConcurrency(5):
        entity no longer exists -> drop the reference row
        span already holds this text -> record and skip
        otherwise:
          rewrite the blurb span (or, for a soft-deleted blurb, unwrap it)
          save via that entity's apply<Entity>ContentChange
            -> whatever follow-up that surface has: see the tracking task
        set materializedHash, materializedAt
  |
  +-- hard-delete soft-deleted blurbs that now have no references
```

The skip is not an optimisation for the expected path — the hash comparison already handles
that. It is there so that a bug anywhere upstream costs a read rather than a fan-out of no-op
writes, each of which would otherwise carry a scan and an index sync.

Dispatch is a registry keyed by `entityType`, deliberately shaped like
`moderation-adapters.ts` — one map, one registration per supported surface:

```ts
const adapters: Record<string, BlurbFanoutAdapter> = {
  Article: { load, save },           // save -> applyArticleContentChange
  Model: { load, save },             // save -> applyModelContentChange
  ModelVersion: { load, save },      // save -> applyModelVersionContentChange
  Bounty: { load, save },            // save -> applyBountyContentChange
  CosmeticShopItem: { load, save },  // save -> applyCosmeticShopItemContentChange
};
```

Each adapter calls a **narrow content-update function** on its entity's service — not the
form-shaped upsert, and never raw SQL.

🔴 **The registry's keys are also the selector.** `getSupportedBlurbEntityTypes()` filters the stale
query, so an `entityType` that does not match a key is not merely skipped per row — it is invisible
to the job while `reconcileBlurbReferences` keeps writing rows under it. Excluding them at the
selector rather than in the batch is what stops them starving the queue: a row the job cannot
rewrite never gets its `materializedAt` touched, so once there were `limit` of them they would
permanently occupy the head of the `ORDER BY materializedAt` window. The `unsupportedBacklog`
counter — a table-wide count, emitted on the half-hour because it cannot range-scan — is the only
thing that surfaces the mismatch.

The distinction matters and is easy to get wrong. `upsertArticle` and its siblings take a whole
form payload: title, tags, attachments, cover image. A background job holds none of that, and
calling one with a partial payload does not update a column — it clears every field it omitted.

Writing the column and stopping there is the other wrong answer: it skips the moderation scan, the
search-index sync and the cache invalidation, which is to say it skips the entire reason for
materializing.

So each surface needs a small function that owns "this entity's rich text changed" — the column
write plus the follow-up work — which the full upsert calls too. The fan-out then reuses the hooks
rather than reimplementing them, and neither path can drift from the other. They are
`applyArticleContentChange`, `applyModelContentChange`, `applyModelVersionContentChange`,
`applyBountyContentChange` and `applyCosmeticShopItemContentChange`.

🔴 **The column write inside them is raw SQL, and `@updatedAt` is the one thing the fan-out must NOT
inherit from a normal edit.** Prisma stamps `@updatedAt` on every client-side `update()`, and a
blurb re-materialization is not a creator edit: bumping `Article.updatedAt` or `Model.updatedAt`
would reorder the "recently updated" feeds on every pass, and on articles it would reopen the
rating-dispute re-edit window keyed on `updatedAt > resolvedAt`. A caller that has already written
the body passes its snapshot in `context`, which skips both the raw write and the image-linking
pass — the fan-out needs neither. A blurb's interior cannot hold an image (`img` and `edge-media`
are not in `BLURB_INTERIOR_ALLOWED_TAGS`), so a re-materialization never changes the body's image
set, and the `Rescan` stamp that pass used to write was itself a Prisma update — which put
`@updatedAt` back on the row the raw write had just avoided.

Each `apply…ContentChange` also re-runs `throwOnBlockedLinkDomain` on the post-splice body: the
blocklist can move after a blurb was saved and the fan-out has no user in the loop to catch it. That
is also the likeliest reason a single row throws, which is why the job catches per row rather than
per batch — `limitConcurrency` rejects its whole batch on the first thrown error, so without the
catch one newly-blocklisted domain in one article would abort every other row in the pass, on every
run, forever.

The job is registered in the `jobs` array in `src/pages/api/webhooks/run-jobs/[[...run]].ts`, which
per the repo's conventions is the whole registration. It runs `*/5 * * * *` with `lockExpiration` at
15 minutes — deliberately longer than the cadence, because at `lockExpiration == the cron period` a
long pass self-releases mid-run and the next tick starts a second overlapping pass over unclaimed
rows (the selector is a plain SELECT, no row locking). Concurrency within a pass is bounded by
`limitConcurrency` (`concurrency-helpers.ts`) at 5, and the batch at 500, so an oversized backlog
drains across several runs rather than in one.

### Volume, and why it is not capped

**There is no limit on how many entities may reference a blurb.** An earlier draft capped it at
250; that was rejected as too small, since creators with hundreds of models are exactly the
people who want this. The cost is accepted instead: a blurb edit may be a lot of writes.

Be clear-eyed about what that means. There is no cross-entity shortcut — scan deduplication is
per entity and temporal (`orchestrator.service.ts:456`), and two models sharing a footer still
have different surrounding text — so N references is genuinely N writes, N scans, N index syncs.
A creator with two thousand models editing one blurb is two thousand of each.

**So the fan-out needs monitoring before the flag ramps**, not after: entities rewritten per
run, per blurb and per creator, and how far the backlog is behind. The expectation is that most
creators never use this and the real numbers stay small, but that is a prediction, and the
instrumentation is how it stops being one. The job can also wedge, and nothing tells you it has
except those numbers.

### Deleting a blurb, and entities that vanish

**Deletion is soft, and the unwrap goes through the same job.** Deleting sets `deletedAt`,
which hides the blurb from the picker immediately. The job then treats its references as work of
a different kind: rewrite each entity with the span *unwrapped*, leaving the last text as plain
content, and drop the reference row. When the last one is gone the blurb row can be hard-deleted.

A hard delete up front cannot work: `BlurbReference` cascades, so the rows naming the entities
that need unwrapping are destroyed by the very operation that needs them. The unwrap is also
asynchronous, so a synchronous delete has nothing to wait on. Soft deletion keeps the work list
alive until the work is done.

Published content never breaks because a blurb went away — it keeps the words it had, as
ordinary markup.

**References can outlive their entity.** `entityType`/`entityId` is a loose pair, not a foreign
key, so deleting an article leaves its reference row behind. Each adapter's `load` returns `null`
when its entity no longer exists, and the job drops the row rather than retrying it forever. Without
that, one deleted article is a permanent item in the backlog and the backlog-age metric degrades
into noise.

---

## Moderation

**A blurb is not a moderated object.** It is text a creator stores and the editor pastes. Nothing is
added to the moderation system for it — the list below is exhaustive and deliberate:

| Not added | |
|---|---|
| A `Blurb` entityType | no adapter, no registry entry |
| A blurb scan | the `Blurb` table has no `auditStatus`, `nsfw`, `nsfwLevel` or `auditedAt` |
| A review queue | nothing routes a blurb anywhere for review |
| nsfwLevel propagation | a blurb has no rating to propagate |

One check does run against a blurb itself: `throwOnBlockedLinkDomain` on create and update, because
a blurb body is spliced into entities that were domain-checked before it arrived. Every
`apply<Entity>ContentChange` re-runs it on the post-splice body for the same reason.

What happens instead: the fan-out write is an ordinary edit by the content's owner, so whatever
moderation that entity's update path already runs is what runs — unchanged, and uninvoked by
anything blurb-specific. An entity's rating moves because that entity's own text changed, which
is exactly what happens when a creator types the same words by hand.

Composition is covered for free, because the thing submitted is the entity's whole text after
expansion rather than the blurb in isolation. That is the reason a blurb-level scan would not
help even if one existed: it cannot see the surrounding content, which is where the concern
was.

Between a fan-out write and its verdict returning there is a window in which new text is live
and not yet reviewed. That window is the same one an ordinary hand edit already has — the same
function, the same non-blocking submit — and matching it is deliberate. The fan-out could be
made stricter than the interactive path by waiting on each scan before committing
(`submitTextModeration` accepts `wait`), and that option stays open, but shipping the fan-out
with different semantics than a manual edit was not judged worth the complexity.

Per-surface moderation coverage is recorded on the tracking task rather than here.

---

## Surfaces

Enabled in v1:

- model descriptions (`Model`) and model version descriptions (`ModelVersion`)
- articles (`Article`)
- bounties (`Bounty`)
- the cosmetic shop (`CosmeticShopItem`)

**Challenges and changelogs were dropped during the build**, neither for effort:

- **Challenge** — a description change resets `ingestion` to `Pending`, which hides a live challenge
  from the feed. A fan-out rewrite would take a running challenge down.
- **Changelog** — it has no author column, so a blurb span in one resolves against the acting
  moderator rather than a content owner. `expandBlurbs` has no owner to key on.

Not in v1 either: **comments and reviews.** They are the highest-volume surfaces in the app, and a
single blurb edit reaching thousands of comment rows is a different risk and cost profile than
one reaching a creator's own catalogue. Worth revisiting once the fan-out has run in production
at a smaller scale.

---

## Editor

Screens are in `designs/reusable-blurbs.pen` (components at canvas `y 0`, screens at `y 1000`):
the toolbar control and an inserted chip, the manager modal's list / create / edit / delete views,
the `//` suggestion popover, and the empty, at-limit, orphaned-chip and narrow-screen states.

A new Tiptap node, `src/shared/tiptap/blurb.node.ts`, modelled closely on
`src/components/Generate/Input/SnippetCategory.ts` — which is the same idea already built for
the generator's prompt editor and solves most of the same problems.

- The node is atomic and not editable in place, so the expanded text cannot drift from the
  blurb by hand-editing one copy.
- `renderHTML` emits the span with the text as children, which is what puts the materialized
  form in `editor.getHTML()`.
- A node view renders it as a distinguishable chip so a creator can see which parts of a
  document are shared.
- Orphan handling — a chip whose blurb no longer resolves — is derived at render from the picker's
  resolved list (`BlurbNode.tsx`), **not** carried as a `data-orphan` attribute the way
  `SnippetCategory` does it: an attribute would be written into the stored body, where nothing would
  ever clear it. No chip reads as orphaned until the list has resolved at least once, or a pending
  query flags every chip in the document as deleted.

Two entry points, one list component:

- a toolbar control, gated by adding `'blurb'` to `ControlType` in `RichTextEditorComponent.tsx`
- an inline `//` trigger, built with the suggestion factory pattern from
  `snippetCategorySuggestion.ts`. `//` rather than `/` because a lone slash is common in prose;
  the trigger fires only at input start or after whitespace, so `https://` does not open it.

Management lives in the modal the toolbar opens: list, insert, create, edit, delete. No new
route and no separate page in v1. A blurb's name is set once at creation and cannot be changed
afterwards, so the field is read-only on edit.

The modal shows usage — *"used in 14 places"* — straight from `BlurbReference`, with no separate
bookkeeping. It is not a control, since the update is automatic; it is there so a creator
editing a blurb can see that the edit has reach before they make it.

A dedicated management page — in the main app or in Creator Studio — is worth building once
there is evidence creators keep enough blurbs to need one. Usage counts and update history are
what would justify it.

---

## Limits

| Limit | Value | Why |
|---|---|---|
| References per blurb | none | Capping it would exclude the creators who most want this |
| Blurbs per user | 20 | The lever we pull instead; raise on evidence |
| Blurb length | 3,000 characters | A blurb is a footer or a settings block, not an article — and the cap bounds how large a multiple of itself one blurb becomes across every entity using it |
| Blurb name | 60 characters | Set once, immutable |

The first two move together deliberately. With no ceiling on how far one blurb reaches, the way to
bound a creator's total footprint is to bound how many blurbs they keep — so the per-creator limit
is tighter than it would otherwise be, and monitoring covers what neither number does.

`MAX_BLURBS_PER_USER` is duplicated by hand: `blurb.service.ts` is the enforcement point, and
`src/shared/constants/blurb.constants.ts` is the copy the picker reads, because the service module
reaches Prisma and cannot be imported client-side. Change both.

🔴 **Blurb content is INLINE-ONLY and is NOT sanitized like the surface it lands on.** It passes
`BLURB_INTERIOR_SANITIZE_OPTIONS` — `strong`, `em`, `u`, `s`, `a`, `br`, `code`, and no `span` at
all. A block element (`p`, `div`, `ul`, `ol`, `li`, `pre`, `blockquote`, `h1`-`h3`) stored in a blurb
is spliced inside an inline `<span data-type="blurb">` sitting inside the host document's `<p>`; the
HTML parsing algorithm closes that `<p>` on the block start tag, and `span` is not a formatting
element so it is popped rather than reconstructed. The chip is left EMPTY and the text lands as a
detached sibling — then the next save re-splices the body into the empty span and the text appears
twice. Pinned against parse5/jsdom in `blurb-inline-content.test.ts`; happy-dom does not reproduce
it, which is why it went unnoticed.

`sanitizeBlurbInterior` is the single definition of that allowlist and three places enforce it:
`blurbContentSchema` at save, `replaceBlurbSpans` at every splice (both the interactive path and the
fan-out), and `RenderRichText`'s blurb mapping at render. The blurb editor is a full RichTextEditor,
so paragraph boundaries are converted to `<br />` before the strip runs — without that,
`<p>a</p><p>b</p>` sanitizes to `ab` and silently runs the author's words together.

Two gates, covering different things. `featureFlags.textBlurbs` (`availability: ['mod']`,
`fliptKey: 'text-blurbs'`) gates the two INSERTION paths — the toolbar control and the `//` picker —
and never the node, so a blurb span already in a draft keeps parsing. `FLIPT_FEATURE_FLAGS.TEXT_BLURBS`
gates the server-side expansion in `expandBlurbs`, evaluated against the content OWNER so a rollout
picks a sticky subset of creators. Both default off; `isFlipt` returns false for an unknown flag,
and not expanding is the safe failure for a feature that rewrites published content.

🔴 **Ramp `text-blurbs` by percentage or boolean ONLY — a segment rollout matches nothing.**
`expandBlurbs` evaluates it with an entityId and no evaluation context, and every identity/tier/cohort
segment in flipt-state is a `STRING_COMPARISON` constraint that reads the context. A segment rule
there returns the flag default and looks exactly like "blurbs are off". Supplying a context would
mean assembling a `SessionUser` for the owner — whose session neither a moderator's request nor the
fan-out job carries — on a path that runs on every model, article and bounty write. The site is
recorded in `ENTITY_WITHOUT_CONTEXT_LEDGER` (`flipt-eval-context.test.ts`).

**The fan-out job is gated on neither flag**, deliberately: a creator who leaves the rollout keeps
their existing references maintained rather than stranded.

---

## What this reuses

| Need | Existing code |
|---|---|
| Inline reference node, chip rendering, orphan state | `src/components/Generate/Input/SnippetCategory.ts` |
| Trigger-char suggestion popover | `src/components/Generate/Input/snippetCategorySuggestion.ts`, `SnippetCategoryList.tsx` |
| Owner-scoped named text, table shape only | `WildcardSet` |
| Fail-closed strip for a `data-type` span | `isStickerSpan`, `html-sanitize-helpers.ts` |
| Per-entity dispatch registry | `moderation-adapters.ts` |
| Bounded concurrent work | `limitConcurrency`, `concurrency-helpers.ts` |
| Content hashing | `hashContent`, `entity-moderation.service.ts` |

---

## Where later features attach

Creators will ask for more than v1 ships. These are the seams they land on, named now so the
next person extends the design rather than working around it.

**Adding a field to `Blurb`** — archive, description, colour, sort order. Free. Staleness is
hash-derived, so nothing you add can trigger a fan-out. This is the whole point of the previous
section.

**Sharing blurbs — team, org, or public** — changes exactly one function. `expandBlurbs` holds the
single ownership check that decides whose blurb a given `data-id` may resolve to (the query's
`userId` filter, narrowed further by `restrictToBlurbIds` for a non-owner editor). Widen that
predicate and nothing else moves; the editor, the fan-out and the render path never learn about it.
Keep the check there rather than letting call sites decide, or sharing becomes a sweep instead of an
edit.

**A new surface** — four registrations, not the two this section used to claim: `'blurb'` in that
editor's `includeControls`; `allowBlurbs: true` on its zod schema (plus `span` in `allowedTags` if
that schema narrows below the app default — `allowBlurbs` is an attribute strip, not a tag
admission); `expandBlurbs` + a gated `reconcileBlurbReferences` in its service, keyed on the owner;
and an entry in the fan-out adapter registry pointing at its `apply<Entity>ContentChange`. The
sanitizer strip is default-deny, so a surface that registers none of them stays closed. A surface
that registers the first three and not the fourth is the half-enabled state: references accumulate
under an `entityType` the selector filters out, and nothing ever rewrites them.

**Per-surface or variant content** — a blurb that renders differently in an article than in a
model description. This is the one that does not fit: `content` is a single string, and the
hash, the reference row and the span all assume one text per blurb. Doable, but it is a schema
change rather than an extension, so it deserves its own design rather than being bolted on.

---

## What is not done

1. **Apply the migration.** `20260825000000_add_blurbs/migration.sql` is committed and has not been
   run in any environment as of 2026-08-25. Nothing here works until a human runs it; migrations in
   this repo are never auto-applied (CLAUDE.md → Database).
2. **Fan-out monitoring, partially.** The job emits per-run counts to Axiom — `rewritten`,
   `skipped`, `gone`, `failed`, `batchLimit`, `saturated`, and `unsupportedBacklog` on the half-hour
   — plus a `warn` per failing row. Not emitted: **per blurb, per creator, and backlog age**.
   `materializedAt` exists so backlog age is measurable; nothing measures it.
3. **The flag ramp** — percentage or boolean only. See Limits.

Monitoring is not optional and does not belong after the ramp. With no cap on how far a blurb
reaches, the instrumentation is the only thing standing between "most creators won't use this" as an
expectation and as a measured fact.

---

## Deferred

- Comments and reviews as surfaces.
- A dedicated management page, and whether it belongs in Creator Studio.
- Sharing a blurb between users, or team-level blurbs.
- Blurbs in the generator prompt editor — it already has snippet categories.
