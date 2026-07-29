# `isOfficial` model flag — session handoff

**Branch:** `feat/model-is-official` (worktree `C:\work\worktrees\model-is-official`, based off `main`)
**Status:** uncommitted WIP, typechecks clean. Not yet applied to any DB. Not deployed.

This doc is a handoff for a fresh session. It captures what's built, the decisions (and the ones we reversed), and what's left.

---

## What this feature is

A per-model `isOfficial` boolean, used to (a) show an **"Official" badge** on models and (b) let moderators flag/curate which models are "official" (CivitaiOfficial content, typically mirrors of third-party models). It is **mod-curated and decoupled from account ownership** — not just "owned by the CivitaiOfficial account".

The original goal was "official models sort first in the generator resource picker." **That sort mechanism was intentionally removed** — see the decision log.

---

## Change set (what's in this branch)

**DB / schema**
- `packages/civitai-db-schema/prisma/schema.full.prisma` — new `Model.isOfficial Boolean @default(false)`. ⚠️ **This is the canonical schema.** Root `prisma/schema.prisma` is gitignored and auto-generated from it (`scripts/generate-slim-schema.js` via `pnpm run db:generate`) — do NOT hand-edit the root one.
- `packages/civitai-db-schema/src/{kysely/types.ts, models.ts}` — regenerated (contain `isOfficial`).
- `prisma/migrations/20260721130000_model_is_official/migration.sql` — `ADD COLUMN` (metadata-only, fast) + one-time seed `UPDATE "Model" SET "isOfficial" = true WHERE "userId" = 12042163` (the CivitaiOfficial account). **Migrations are applied manually here — this has NOT been run.**
- `src/server/selectors/model.selector.ts` — `isOfficial` added to `modelSearchIndexSelect` (→ Meili doc) and `modelWithDetailsSelect` (→ model detail page).

**Backend — moderator toggle**
- `src/server/services/model.service.ts` — `setModelOfficial({ id, isOfficial, isModerator })` sets the column + queues a search-index update for that model.
- `src/server/schema/model.schema.ts` — `setModelOfficialSchema` (`{ id, isOfficial }`).
- `src/server/routers/model.router.ts` — `model.setOfficial` (moderatorProcedure).

**Search index**
- `src/server/search-index/models.search-index.ts` — the `isOfficial` **boolean** field flows onto each Meili doc via the row spread (`...model`); it is just document data (no settings reindex needed). It is **NOT** a sortable attribute (deliberately — see below).

**Frontend**
- `src/components/ImageGeneration/GenerationForm/ResourceSelectModal/ResourceSelectCard.tsx` — yellow **"Official"** badge (`IconRosetteDiscountCheck`, tooltip "Official Civitai model"), rendered when `!!data.isOfficial`.
- `src/pages/models/[id]/[[...slug]].tsx` — "Mark/Unmark Official" item in the model moderator menu (calls `trpc.model.setOfficial`, optimistic cache update).

**Unrelated refactor bundled on this branch** (quick-win #1 from the modal proposal — keep or split out as you prefer):
- `src/components/Search/utils/meili-filter.ts` — new typed Meili filter builder (`and/or/eq/ne/inArray/not`).
- `src/components/ImageGeneration/GenerationForm/ResourceSelectModal/useResourceSelectFilters.ts` — `useResourceSelectMeiliFilters` rewritten to use the builder; `getTabRestrictionIds` extracted. ⚠️ **Changes the generated filter string** (string values now quoted, insignificant whitespace/paren diffs, and a latent-bug cleanup that drops `undefined` ids). Behavior-equivalent in intent but **verify across all tabs (all/official/mine/recent/liked/featured) against real data before merging.**
- `docs/resource-select-modal-refactor.md` — the broader modal-refactor proposal + checklist (Phase 1 filter-builder done; sort-hook, "split curated tabs off InstantSearch", and the single-server-contract phases are open).

---

## Decision log (important — several were reversed)

1. **Storage: plain `boolean` column.** Rejected `meta` JSON (not queryable) and a bitwise `flags` column (the name `flags` is already the `ModelFlag[]` moderation relation; a single flag didn't justify a bitfield — revisit if many model flags accumulate). "We don't like prisma" — queries are raw SQL / Kysely, so a boolean column indexes/queries cleanly.
2. **Not graded.** Considered 1/2/3 tiers; decided a boolean is enough (only ~a few official models per ecosystem).
3. **🔴 Meili sort ABANDONED.** We first implemented official-first ordering by making `isOfficial` a **sortable** Meili attribute (an `isOfficial:desc` replica used as the picker's `all`-tab sort). Problem: adding a sortable (or filterable) attribute forces Meili to **reindex the sort structures across the ENTIRE index** (~906k docs) — cost scales with total doc count, not the handful that carry the flag — and it **locks the task queue**. Disproportionate for a sparse field, and it hard-fails (`Attribute isOfficial is not sortable`) during the reindex window. So all the sortable-attribute code + frontend sort wiring were **removed**, and the queued `settingsUpdate` tasks were **cancelled** (`POST /tasks/cancel?uids=...`) before they reindexed. The `isOfficial` doc field (non-sortable) was kept for the badge.

---

## What's LEFT to do

- [ ] **Client-side pin (the replacement for the Meili sort).** To make official models appear first on the picker's `all` tab without any reindex: in `ResourceHitList`, stable-sort loaded hits so `data.isOfficial` models float to the top on the `all` tab — mirroring how the **featured podium** already pins client-side. Caveat: only reorders the currently-loaded page(s) of infinite scroll (fine for text searches where official models rank high; weaker for pure no-query browsing). A stronger variant fetches the small official-model list (like `getFeaturedModels`) and pins always. **Not started.**
- [ ] **Apply the migration** (`20260721130000_model_is_official`) to the target DB(s) — manual, per repo convention.
- [ ] **Sync official docs for the badge.** The badge reads `isOfficial` off the Meili doc. The seeded official-account models won't carry the field until their docs are re-synced (normal `*/15` sync only touches *updated* models). Options: a targeted `/api/mod/update-index?index=models_v9&updateIds=<ids>`, `setModelOfficial` re-toggle, or a full models reset. **No reindex needed — it's document data.**
- [ ] **Verify the filter-builder refactor** across all tabs before merge (see warning above), or split it into its own PR.
- [ ] **SEO (deferred — see below).**

## SEO follow-up (model detail page JSON-LD)

The model page emits a `SoftwareApplication` `metaSchema` (`src/pages/models/[id]/[[...slug]].tsx`). `model.isOfficial` is available there (it's in `modelWithDetailsSelect`), so official-only markup is easy. There is **no schema.org "official" property** that yields an SEO badge/boost — the real value is provenance/entity linking:
- **Tier 1 (cheap, no new data):** add `publisher: { '@type':'Organization', name:'Civitai', url }` (mirror the [articles page](../src/pages/articles/[id]/[[...slug]].tsx) which already does this), plus free parity wins the model schema lacks — `dateModified`, `keywords`, `mainEntityOfPage`. For official models, express first-party provenance (`creator`/`provider` = Organization).
- **Tier 2 (the real win for mirrors, needs a new field):** `sameAs` / `isBasedOn` pointing at the **original source** (Hugging Face / provider). Requires storing a structured source URL (e.g. `model.meta.officialSourceUrl`), populated by the mirror-creation flow (`write-model-description` skill). Not present today.

---

## Running this worktree

Fresh worktree — no `node_modules` (gitignored, not copied). Before building/typechecking:

```bash
pnpm install
pnpm run db:generate
pnpm run typecheck    # was clean at handoff
```

`.env` files (root + `apps/auth|notifications|storage` + skill envs) and the `event-engine-common` submodule are already set up.

---

## Gotchas

- Canonical schema = `schema.full.prisma`; regenerate root + kysely via `pnpm run db:generate`.
- The Meili sort is gone on purpose — don't re-add `isOfficial` to `sortableAttributes` (it triggers the full-index reindex we cancelled).
- Don't confuse `Model.isOfficial` with `constants.system.officialUserId` (12042163). The seed uses the account id, but the flag is decoupled/mod-curated after that.
