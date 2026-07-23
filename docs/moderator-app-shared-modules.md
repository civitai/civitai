# Moderator App — Shared Module Boundary

## Goal

Make the 22 moderator pages listed below buildable in a **separate Next.js app** that shares Postgres / Redis / ClickHouse connections with the main app. Identify which existing code must be extracted into a git submodule (or submodules) to make this possible without forking the whole repo.

Related docs: [monorepo-split-overview.md](./monorepo-split-overview.md) (why split), [civitai-schema-common-plan.md](./civitai-schema-common-plan.md) (data-contract submodule, prerequisite for this).

## Pages in scope (22)

**Content review**: `images`, `images/to-ingest`, `image-tags`, `image-rating-review`, `downleveled-review`, `ingestion-error-review`, `articles`, `models/index`, `comics-review`, `reports`, `tags`, `blocklists`, `auditor`, `strikes`
**Scanner audit**: `scanner-audit/index`, `scanner-audit/[mode]/index`, `scanner-audit/[mode]/[label]` (includes per-label policy editing)
**Training**: `training-models`, `review/training-data/index`, `review/training-data/[versionId]`
**CSAM**: `csam/index`, `csam/[userId]`
**Generation**: `generation`, `generation-config`, `generation-restrictions`

## Dependency map (from import analysis)

The 22 pages import code across six tiers. Counts below = how many of the 22 pages import each item.

### Tier A — schema / data contracts (covered by `civitai-schema-common`)

| Import | Pages |
|---|---|
| `~/shared/utils/prisma/enums` | 14 |
| `~/server/common/enums` (NsfwLevel, BlockedReason, BlocklistType, etc.) | 6 |
| `~/shared/constants/browsingLevel.constants` | 3 |
| `~/server/common/constants` | 2 |
| `~/server/schema/report.schema`, `strike.schema`, `image.schema`, `scanner-review.schema` | 5 |
| `~/shared/constants/basemodel.constants` | 1 (generation-config) |
| `~/shared/constants/mime-types`, `~/shared/utils/report-helpers` | 2 |

**Verdict:** All belong in `civitai-schema-common`. The Prisma `~/server/schema/*.schema.ts` zod schemas are a borderline case — they're tRPC input contracts but also the source-of-truth shape for many of these tables. Worth including the moderator-relevant ones since both apps need to agree on them.

### Tier B — tRPC client + auth glue (per-consumer, not shared)

| Import | Pages |
|---|---|
| `~/utils/trpc` | **22** (all) |
| `~/server/utils/server-side-helpers` (createServerSideProps) | 6 |
| `~/providers/FeatureFlagsProvider`, `~/hooks/useFeatureFlags` | 5 |
| `~/hooks/useCurrentUser`, `~/hooks/useIsMobile`, `~/hooks/useInView`, `~/hooks/useStepper` | 7 (combined) |
| `~/types/router` (inferred tRPC types) | 2 |

**Verdict:** Each app needs its own copy. The satellite app stands up its own tRPC client pointing at its own router (or proxies to the main app's router). Hooks like `useCurrentUser`/`useIsMobile` are small enough to vendor-copy.

### Tier C — moderator-specific shared components (candidates for a moderator submodule)

| Import | Pages |
|---|---|
| `~/components/Meta/Meta` | 9 |
| `~/components/AppLayout/Page`, `~/components/AppLayout/NotFound` | 7 |
| `~/components/Moderation/*` (ScannerAuditLayout, ScannerPolicySidebar, FlaggedModelsList, RuleDefinitionPopover, GenerationStatusCard, UserGenerationsDrawer) | 5 |
| `~/components/Csam/*` (CsamProvider, CsamDetailsForm, CsamImageSelection, useCsamImageSelectStore) | 4 |
| `~/components/Dialog/dialogStore`, `~/components/Dialog/Common/TosViolationDialog`, `~/components/Dialog/triggers/*` | 6 |
| `~/components/Profile/UserBanModal` | 2 |
| `~/store/select.store` | 2 |

**Verdict:** These are predominantly used by the moderator pages — natural fit for a moderator-specific submodule.

### Tier D — Civitai UI vocabulary (the awkward middle)

These are not moderator-specific — they're used everywhere in the main app — but the moderator pages can't render without them.

| Import | Pages |
|---|---|
| `~/components/NextLink/NextLink` | 16 |
| `~/components/EdgeMedia/*` (EdgeMedia, EdgeVideo, EdgeVideoBase) | 8 |
| `~/components/NoContent/NoContent` | 6 |
| `~/components/LegacyActionIcon/LegacyActionIcon` | 6 |
| `~/components/InView/InViewLoader` | 4 |
| `~/components/ImageGuard/ImageGuard2` | 3 |
| `~/components/ImageMeta/ImageMeta`, `~/components/VotableTags/VotableTags`, `~/components/ImageHash/ImageHash`, `~/components/MasonryColumns/*`, `~/components/ContentClamp/ContentClamp`, `~/components/RenderHtml/RenderHtml`, `~/components/DescriptionTable/DescriptionTable`, `~/components/PopConfirm/PopConfirm`, `~/components/CivitaiWrapped/ButtonTooltip` | 16 (combined) |

**Verdict:** Three options:
1. **Vendor-copy into satellite** — simple, but the two apps' UI will drift visually over time
2. **Promote to a `civitai-ui-common` submodule** — clean long-term, but a *big* extraction (every main-app file importing these gets rewritten)
3. **Start vendored, promote later** — pay the duplication cost early, promote when drift becomes painful

Recommend option 3.

### Tier E — domain helpers (vendor-copy or duplicate)

| Import | Pages |
|---|---|
| `~/utils/notifications` (showError/SuccessNotification) | 15 |
| `~/utils/string-helpers` | 9 |
| `~/utils/date-helpers` | 6 |
| `~/libs/form` (Form, InputTextArea, InputNumber, InputSelect, useForm) | 3 |
| `~/utils/moderators/moderator.util`, `~/utils/number-helpers`, `~/utils/file-utils`, `~/utils/lazy`, `~/utils/training`, `~/utils/type-guards`, `~/utils/normalize-text`, `~/utils/metadata/audit`, `~/client-utils/cf-images-utils`, `~/hooks/useCheckProfanity` | scattered |

**Verdict:** Small, mostly-pure utilities. Easiest path is vendor-copy into satellite; promote anything heavily reused to `civitai-ui-common` along with Tier D when the time comes. `useCheckProfanity` is the exception — it hits a server endpoint, so its hook must travel with the auditor page and the satellite needs the backing endpoint.

### Tier F — porting blockers (need refactor in place before extraction)

| Import | Page | Blocker |
|---|---|---|
| `~/server/services/image.service` (type imports) | `image-rating-review`, `downleveled-review`, `ingestion-error-review` | Type-only imports today, but the *underlying functions* must run somewhere. Either satellite hosts these tRPC routes (drags in image.service) or the satellite calls main-app over HTTP. |
| `~/server/services/scanner-review.service`, `~/server/services/scanner-content.service` | `scanner-audit/[mode]/[label]` | Scanner audit queue + per-label content fetch. Tied to xguard orchestrator callbacks. Refactor: clarify what's a read-only query vs. what's an orchestrator interaction. |
| `~/server/common/moderation-helpers` (`unpublishReasons`) | `articles`, `models` | Moderator-only domain logic. Should be promoted into Tier A (schema-common) — it's effectively a stable enum. |
| `~/components/Image/PromptHighlight/PromptHighlight`, `useReportCsamImages` | `images.tsx` | PromptHighlight drags in metadata audit utilities; CSAM hook couples to main app's dialog/notification machinery. Refactor: extract pure highlighter; reimplement CSAM hook against satellite's dialog system. |

## Per-page portability summary

| Page | Imports | Portability |
|---|---|---|
| `images/to-ingest` | 5 | **Easy** |
| `image-rating-review` | 15 | **Easy** |
| `downleveled-review` | 11 | **Easy** |
| `ingestion-error-review` | 9 | **Easy** |
| `comics-review` | 18 | **Easy** |
| `strikes` | 17 | **Easy** |
| `review/training-data/index` | 12 | **Easy** |
| `image-tags` | 21 | **Medium** |
| `articles` | 20 | **Medium** (unpublishReasons) |
| `models/index` | 16 | **Medium** (FlaggedModelsList) |
| `reports` | 28 | **Medium** |
| `tags` | 20 | **Medium** |
| `blocklists` | 11 | **Medium** |
| `training-models` | 16 | **Medium** |
| `review/training-data/[versionId]` | 19 | **Medium** |
| `csam/index` | 8 | **Medium** |
| `csam/[userId]` | 15 | **Medium** |
| `generation-config` | 9 | **Medium** (basemodel.constants) |
| `images` | 34 | **Hard** (PromptHighlight, CSAM hooks) |
| `auditor` | 4 | **Hard** (useCheckProfanity) |
| `scanner-audit/[mode]/index` | 14 | **Hard** (ScannerAuditLayout, xguard) |
| `scanner-audit/[mode]/[label]` | 18 | **Hard** (scanner-content service) |
| `generation-restrictions` | 14 | **Hard** (UserGenerationsDrawer) |

7 Easy / 11 Medium / 6 Hard

## Recommended module structure

Three submodules, introduced incrementally:

### 1. `civitai-schema-common` — already planned

Per [civitai-schema-common-plan.md](./civitai-schema-common-plan.md). Covers Tier A. Prerequisite for everything below.

**Addition to that plan from this analysis:**
- Include the moderator-relevant `~/server/schema/*.schema.ts` zod files (`report`, `strike`, `image`, `scanner-review`, `buzz-withdrawal-request`, `model-version`)
- Promote `~/server/common/moderation-helpers.unpublishReasons` and other stable enum-shaped exports from `~/server/common/enums` and `~/server/common/constants` (NsfwLevel, BlockedReason, BlocklistType, MAX_APPEAL_MESSAGE_LENGTH, etc.)

### 2. `civitai-moderator-common` — new

Tier C contents plus the moderator pages themselves once they're portable. Satellite app's `src/pages/moderator/*` are thin re-exports.

```
civitai-moderator-common/
├── components/
│   ├── Moderation/         # ScannerAuditLayout, ScannerPolicySidebar,
│   │                         FlaggedModelsList, RuleDefinitionPopover,
│   │                         GenerationStatusCard, UserGenerationsDrawer
│   ├── Csam/               # CsamProvider, CsamDetailsForm,
│   │                         CsamImageSelection, useCsamImageSelectStore
│   ├── Dialog/             # dialogStore + moderator-specific dialogs
│   └── Profile/UserBanModal/
├── pages/                  # the 22 page components (after refactor)
├── server/
│   ├── routers/            # moderator-* tRPC routers
│   └── services/           # moderator-specific service code that satellite
│                             must run locally (or, alternatively, thin
│                             clients that call main app's tRPC)
└── README.md
```

### 3. `civitai-ui-common` — deferred

Tier D contents (EdgeMedia, ImageGuard2, MasonryColumns, NextLink, etc.). Promoted from vendor-copy when drift becomes painful. Likely a 6–12 month follow-on, not blocking the initial split.

## Phased rollout

**Phase 0** — Ship `civitai-schema-common` per the existing plan (phases 1–5). Satellite app cannot start before this.

**Phase 1** — Refactor the 6 Tier F blockers **in place** in the main app:
- ~~Extract `useUnsupportedResources` from generation form coupling~~ — resolved: the hook and its
  only consumer (`/moderator/generation`) were removed when the generation blacklist moved to the
  `ModelVersionFlag.GenerationDisabled` bit.
- Extract `PromptHighlight` from metadata-audit coupling
- Refactor `useReportCsamImages` to depend on a dialog-system interface, not the concrete main-app dialog store
- Decide: scanner-content service satellite-owned, or tRPC-proxied to main app?
- Decide: image.service moderator queries satellite-owned, or tRPC-proxied?

**Phase 2** — Stand up satellite Next.js app with:
- `civitai-schema-common` submodule
- Vendor-copied Tier D (UI primitives) and Tier E (helpers) — accept duplication
- Its own tRPC client + auth setup
- Port the 7 Easy pages first as proof-of-concept

**Phase 3** — Create `civitai-moderator-common` submodule. Move Tier C components into it. Move moderator pages into it as they become portable. Both main app and satellite import from the submodule (during transition, main app keeps the pages working; eventually main app drops them).

**Phase 4** — Migrate Medium pages (11) once Tier F refactors are done.

**Phase 5** — Migrate Hard pages (6). Most are hard because of single specific couplings — once those are addressed, they drop to Medium.

**Phase 6 (deferred)** — Promote Tier D into `civitai-ui-common` when duplication friction is real.

## Open questions

@dev:* Decisions needed before Phase 1:

1. **tRPC topology.** Does the satellite app run its own routers against shared DB (drags in services into the submodule), or call main-app's tRPC over HTTP (simpler, but adds network hop and couples uptime)?
2. **Scope of `civitai-moderator-common`.** Just components + server code, or the full pages too?
3. **Page authorship during transition.** While moving a page from main app → submodule, do we keep it working in both, or cut over hard?
4. **Auth.** Satellite needs to know "is this user a moderator." Does it share the NextAuth session cookie with main app (same domain), use its own login, or call main-app `/api/auth/session` to verify?
5. **CSAM page handling.** CSAM is the most sensitive thing in the list. Confirm it should move to the satellite at all (vs. staying in main app for security review/audit-trail reasons).
