# Reusable Text Blurbs

**Status**: Approach agreed in review, not built
**Tracking**: CU 868kv243c
**Last Updated**: 2026-08-25

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

Authoring shortcuts do not solve this. A template you paste is still forty copies afterwards.
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
text means the render path, the API and the search index need no knowledge of blurbs at all.

**A blurb edit becomes an ordinary entity edit.** Because the text lives in the column, changing
a blurb means writing that column — which means going through the entity's normal update
function, which means everything hanging off that function fires: its moderation scan, its
search-index sync, its cache invalidation. None of that has to be rebuilt for blurbs. This is
what keeps the feature small.

It also degrades well. Delete every blurb, revert the feature, drop the table — the text is
still sitting in the content, and the span is inert markup the sanitizer already permits.

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
hash, so no field anyone adds can make a reference go stale. It is also self-enforcing in a way
a convention is not: a raw SQL backfill or an admin script that changes content still moves the
hash, because the hash is computed from the value rather than promised by a code path.

Reuse `hashContent` (`entity-moderation.service.ts:97`) rather than adding a second hashing
helper.

Three layers do the work, each protecting the one below it:

| Layer | Job | Cost when it is wrong |
|---|---|---|
| `updatedAt > lastRun` | select candidate blurbs, indexed | over-selects; harmless |
| hash comparison | decide staleness | exact |
| no-op guard in the writer | span already correct → skip | one read, never a write or a scan |

The top layer is what Justin described — find blurbs touched since the last run, via
`getJobDate`, then look at their references. It is now **allowed to be sloppy**. A rename bumps
`updatedAt`, the job picks the blurb up, the hash matches, and it stops. Over-selection is free
because it terminates at a comparison rather than at a write.

It is also self-healing with no queue state to reconcile. A reference whose hash does not match
is stale, whatever went wrong before, so a crashed or half-finished run needs no recovery logic.
It is simply picked up next pass.

`materializedAt` carries no correctness weight. It exists so backlog age is measurable.

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

**At the schema layer**, blurb spans are stripped unless the surface opted in. This mirrors the
sticker strip in `html-sanitize-helpers.ts` and exists for the same reason: `span` and its
`data-*` attributes are already in `DEFAULT_ALLOWED_ATTRIBUTES`, so blurb markup would
otherwise survive on *every* rich-text surface, including ones that never enabled the feature.
Default-deny means a surface added later fails closed.

**At the service layer**, each opted-in upsert calls a shared
`materializeBlurbs({ userId, entityType, entityId, html })` before writing, which:

1. verifies each `data-id` belongs to the saving user, dropping the span otherwise,
2. replaces the span's inner content with the blurb row's current text,
3. reconciles this entity's `BlurbReference` rows against the spans that survived.

Step 1 and step 2 are a security requirement, not an optimisation. The inner text arrives from
the client and cannot be trusted: a hand-crafted request could claim blurb 7 says anything at
all, or reference a blurb belonging to somebody else. The server re-expands from the row on
every save, so what is stored is always what the owner's blurb actually says.

---

## The fan-out

Saving a blurb writes one row. A job does the rest.

```
save blurb 7
  |
  +-- write the Blurb row  (content + contentHash)
  |
  v   nothing else happens synchronously

blurb-fanout job
  |
  +-- candidate blurbs: updatedAt > lastRun          (indexed, may over-select)
  +-- their references WHERE materializedHash <> contentHash
  |
  +-- for each, through limitConcurrency:
        if the span already holds this text -> record and skip
        otherwise:
          rewrite the blurb span's inner text
          save via that entity's normal update function
            -> its moderation scan fires
            -> its search-index sync fires
            -> its cache invalidation fires
        set materializedHash, materializedAt
```

The skip is not an optimisation for the expected path — the hash comparison already handles
that. It is there so that a bug anywhere upstream costs a read rather than a fan-out of no-op
writes, each of which would otherwise carry a scan and an index sync.

Dispatch is a registry keyed by `entityType`, deliberately shaped like
`moderation-adapters.ts` — one map, one registration per supported surface:

```ts
const blurbFanoutAdapters: Record<string, BlurbFanoutAdapter> = {
  Article: { rewrite: ... },   // upsertArticle
  Model: { rewrite: ... },     // updateModelById
  ModelVersion: { rewrite: ... }, // upsertModelVersion
  // ...
};
```

Each adapter calls a **narrow content-update function** on its entity's service — not the
form-shaped upsert, and never raw SQL.

The distinction matters and is easy to get wrong. `upsertArticle` and its siblings take a whole
form payload: title, tags, attachments, cover image. A background job holds none of that, and
calling one with a partial payload does not update a column — it clears every field it omitted.

Writing the column directly is the other wrong answer: it skips the moderation scan, the
search-index sync, the cache invalidation and Prisma's `@updatedAt`, which is to say it skips
the entire reason for materializing.

So each surface needs a small function that owns "this entity's rich text changed" — the column
write plus the follow-up work — which the full upsert calls too. The fan-out then reuses the
hooks rather than reimplementing them, and neither path can drift from the other.

The job is registered in the `jobs` array in `src/pages/api/webhooks/run-jobs/[[...run]].ts`,
which per the repo's conventions is the whole registration. Concurrency within a pass is bounded
by `limitConcurrency` (`src/server/utils/concurrency-helpers.ts:15`), and a pass is capped so a
single run stays bounded — an oversized backlog drains across several runs rather than in one.

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
instrumentation is how it stops being one.

The job is also an operational surface. It can wedge, it needs a way to tell that it has, and
someone has to look. That is the honest price of live update, and it should be weighed as such
rather than waved through because the mechanism is small.

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
key, so deleting an article leaves its reference row behind. Each adapter's `rewrite` reports
back when its entity no longer exists, and the job drops the row rather than retrying it
forever. Without that, one deleted article is a permanent item in the backlog and the
backlog-age metric degrades into noise.

---

## Moderation

**A blurb is not a moderated object.** It is text a creator stores and the editor pastes. This
proposal adds nothing to the moderation system at all — the list below is exhaustive and
deliberate:

| Not added | |
|---|---|
| A `Blurb` entityType | no adapter, no registry entry |
| A blurb scan | the `Blurb` table has no `auditStatus`, `nsfw`, `nsfwLevel` or `auditedAt` |
| A review queue | nothing routes a blurb anywhere for review |
| nsfwLevel propagation | a blurb has no rating to propagate |

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

Enabled in v1, all via the existing `includeControls` opt-in on the shared editor:

- model descriptions and model version descriptions
- articles
- bounties, challenges, changelogs, cosmetic shop

Not in v1: **comments and reviews.** They are the highest-volume surfaces in the app, and a
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
- Orphan handling — a chip whose blurb no longer resolves — already exists in `SnippetCategory`
  via `data-orphan` and carries over.

Two entry points, one list component:

- a toolbar control, gated by adding `'blurb'` to `ControlType` in
  `RichTextEditorComponent.tsx:503`
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
| Blurb length | Same cap as the target surface | Blurb text is ordinary content |

The two move together deliberately. With no ceiling on how far one blurb reaches, the way to
bound a creator's total footprint is to bound how many blurbs they keep — so the per-creator
limit is tighter than it would otherwise be, and monitoring covers what neither number does.

Blurb content passes the same sanitizer as the surface it lands on.

Shipped behind a Flipt flag (`FLIPT_FEATURE_FLAGS`, default off, like every flag there).

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
| Content hashing | `hashContent`, `entity-moderation.service.ts:97` |
| Job's last-run watermark | `getJobDate`, `src/server/jobs/job.ts` |

---

## Where later features attach

Creators will ask for more than v1 ships. These are the seams they land on, named now so the
next person extends the design rather than working around it.

**Adding a field to `Blurb`** — archive, description, colour, sort order. Free. Staleness is
hash-derived, so nothing you add can trigger a fan-out. This is the whole point of the previous
section.

**Sharing blurbs — team, org, or public** — changes exactly one function. `materializeBlurbs`
holds the single ownership check that decides whose blurb a given `data-id` may resolve to.
Widen that predicate and nothing else moves; the editor, the fan-out and the render path never
learn about it. Keep the check there rather than letting call sites decide, or sharing becomes a
sweep instead of an edit.

**A new surface** — two registrations: `'blurb'` in that editor's `includeControls`, and an
entry in the fan-out adapter registry pointing at its existing update function. The sanitizer
strip is default-deny, so a surface that registers neither stays closed rather than silently
half-enabled.

**Per-surface or variant content** — a blurb that renders differently in an article than in a
model description. This is the one that does not fit: `content` is a single string, and the
hash, the reference row and the span all assume one text per blurb. Doable, but it is a schema
change rather than an extension, so it deserves its own design rather than being bolted on.

---

## Build order

1. `Blurb` + `BlurbReference` tables, migration, CRUD service and tRPC router.
2. `materializeBlurbs` plus the schema-layer strip; wire into one surface end to end.
3. Tiptap node, toolbar control, `//` suggestion, management modal.
4. Usage display — reference counts per blurb in the modal.
5. Fan-out registry and job.
6. Fan-out monitoring: entities rewritten per run, per blurb and per creator, plus backlog age.
7. Remaining surfaces, then the flag ramp.

Step 2 is the one to get right first: it is where ownership is enforced and where the stored
form is decided, and everything downstream assumes it holds.

Step 6 is not optional and does not belong after the ramp. With no cap on how far a blurb
reaches, the instrumentation is the only thing standing between "most creators won't use this"
as an expectation and as a measured fact.

---

## Deferred

- Comments and reviews as surfaces.
- A dedicated management page, and whether it belongs in Creator Studio.
- Sharing a blurb between users, or team-level blurbs.
- Blurbs in the generator prompt editor — it already has snippet categories.
