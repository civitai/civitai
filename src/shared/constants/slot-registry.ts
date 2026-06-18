/**
 * App Blocks — SLOT REGISTRY (Phase 0 foundation).
 *
 * Single source of truth for every place an App Block can render. Today that is
 * the three model-page slots (unchanged from the historical
 * `blocks.router.ts` `z.enum`) plus one new full-page slot for W10 full-page
 * apps. The registry is the durable shape every downstream derives from:
 *
 *   - `KNOWN_SLOT_IDS`  — the zod enum re-exported by blocks.router.ts; its
 *                         `.options` MUST stay byte-for-byte the historical
 *                         3-model-slot tuple (regression-locked in
 *                         __tests__/slot-registry.test.ts) so the model
 *                         install / mint / resolve path is behavior-preserving.
 *   - client TS unions  — src/components/AppBlocks/types.ts
 *   - marketplace filters — src/pages/apps/index.tsx (model-entity region slots
 *                         only; the page slot must not pollute the model filter)
 *
 * ENTITY-AWARENESS: each slot declares the entity its context binds to. Today
 * only `model` (the three model slots) and `none` (the viewer-scoped page) are
 * used. `user`/`image` are reserved for Phase 1/2 (profile / image / OSD
 * surfaces) and are intentionally NOT wired into the token mint, context types,
 * or install resolver yet — the entity dispatch is shaped so they slot in later
 * without reworking the model or page paths.
 */
import * as z from 'zod';

/** The surface an entity-bound slot reads its context from. */
export type SlotEntity = 'model' | 'user' | 'image' | 'none';

/**
 * How a slot renders:
 *   - `region`   — an inline panel inside an existing page's layout column
 *                  (today's three model slots).
 *   - `floating` — a floating/overlay surface (reserved; e.g. OSD).
 *   - `page`     — a full-bleed standalone page (W10 full-page apps). The block
 *                  owns the whole viewport region under the host trust chrome.
 */
export type SlotKind = 'region' | 'floating' | 'page';

/**
 * How an app is installed/attached to a slot:
 *   - `model_subscription` — a `block_user_subscriptions` row (today's model
 *                            installs + platform defaults + viewer subs).
 *   - `none`               — STATELESS: no install row at all. A `page` app is
 *                            resolved directly from the approved `AppBlock`
 *                            (synthetic `page_<appBlockId>` id) — see Decision 2
 *                            in the W10 plan. No per-content install, no
 *                            migration.
 */
export type SlotInstallModel = 'model_subscription' | 'none';

export interface SlotDef {
  /** Stable slot id used in manifests, JWT ctx, and routing. */
  id: string;
  kind: SlotKind;
  /** The entity this slot's context binds to (drives the entity dispatch). */
  entity: SlotEntity;
  /**
   * Coarse geometry hint for the host. `region` slots live inside an existing
   * page column; `page` slots are full-viewport. Purely advisory to the host
   * renderer — the manifest's iframe min/max height still governs region slots.
   */
  geometry: 'column' | 'viewport';
  installModel: SlotInstallModel;
  /** Default install ordering priority (lower renders first). */
  defaultPriority: number;
  /** Human description for the marketplace / docs. */
  description: string;
}

/**
 * The canonical slot registry. The three model slots are LOAD-BEARING and
 * behavior-preserving — their ids, order, entity, and install model match the
 * pre-registry `blocks.router.ts` `z.enum` exactly. The `page` slot is new
 * (W10) and is the ONLY non-model-entity slot today.
 */
export const SLOT_REGISTRY = {
  'model.sidebar_top': {
    id: 'model.sidebar_top',
    kind: 'region',
    entity: 'model',
    geometry: 'column',
    installModel: 'model_subscription',
    defaultPriority: 0,
    description: 'Top of the model page sidebar.',
  },
  'model.below_images': {
    id: 'model.below_images',
    kind: 'region',
    entity: 'model',
    geometry: 'column',
    installModel: 'model_subscription',
    defaultPriority: 1,
    description: 'Below the model page image gallery.',
  },
  'model.actions_extra': {
    id: 'model.actions_extra',
    kind: 'region',
    entity: 'model',
    geometry: 'column',
    installModel: 'model_subscription',
    defaultPriority: 2,
    description: 'Extra model page actions area.',
  },
  // W10 — full-page app surface. Pure viewer-scoped (entity=none): no model /
  // user / image entity, no per-content install (stateless). Resolved from the
  // approved AppBlock directly via a synthetic `page_<appBlockId>` id.
  'app.page': {
    id: 'app.page',
    kind: 'page',
    entity: 'none',
    geometry: 'viewport',
    installModel: 'none',
    defaultPriority: 0,
    description: 'Full-page standalone app surface.',
  },
} as const satisfies Record<string, SlotDef>;

export type SlotId = keyof typeof SLOT_REGISTRY;

/** The W10 page slot id, named so reuse sites read intent. */
export const PAGE_SLOT_ID = 'app.page' as const;

/**
 * The historical model-slot tuple — the EXACT order/values the pre-registry
 * `KNOWN_SLOT_IDS` z.enum carried. Pinned here as the single source so
 * blocks.router.ts re-exports it (keeping the `KNOWN_SLOT_IDS` name so reuse
 * sites at 287/317/1665 are untouched) and the marketplace can filter to the
 * model slots without re-listing them. Regression-locked in the test.
 */
export const MODEL_SLOT_IDS = [
  'model.sidebar_top',
  'model.below_images',
  'model.actions_extra',
] as const;

export type ModelSlotId = (typeof MODEL_SLOT_IDS)[number];

/**
 * Derived zod enum over the model slots — re-exported by blocks.router.ts as
 * `KNOWN_SLOT_IDS`. KEPT model-only (the three model slots) so the model
 * install/mint/resolve contracts are byte-identical to pre-registry. The page
 * slot is intentionally NOT in this enum — page tokens never flow through the
 * model `slotContextSchema` / `listForModel` / install procs.
 */
export const KNOWN_SLOT_IDS = z.enum(MODEL_SLOT_IDS);

/** All registered slot ids (model + page). */
export const ALL_SLOT_IDS = Object.keys(SLOT_REGISTRY) as SlotId[];

/** Type guard: is `id` a registered slot id (any kind)? */
export function isKnownSlotId(id: string): id is SlotId {
  return id in SLOT_REGISTRY;
}

/**
 * Money/spend scopes a `page` (viewer-scoped, entity=none) token must NEVER
 * carry. This is the belt over the manifest + approved-scope intersection: even
 * if an app's approved manifest declared one of these, a `kind==='page'` mint
 * rejects it.
 *
 * W10 generation spend: `ai:write:budgeted` is NO LONGER forbidden for pages.
 * A page is stateless (no install settings row), so its per-generation budget
 * comes from the approved manifest's `page.buzzBudgetPerGen` field — server-read,
 * clamped to BUZZ_BUDGET_CAP, defaulted to BUZZ_BUDGET_DEFAULT when the manifest
 * omits it (see resolveBuzzBudget in the mint handler). Page generation spend is
 * therefore bounded by exactly the same two limits a model slot is: the per-gen
 * `buzzBudget` claim AND the per-user daily cap (BLOCK_BUZZ_CAP_PER_DAY in
 * blocks.router.ts) — neither is bypassed for pages.
 *
 * The two scopes below STAY forbidden for pages:
 *   - `social:tip:self` — tipping is NOT gated by the buzzBudget cost-preflight,
 *     so the manifest budget cap does not bound it. On a stateless page (no
 *     per-content owner to attribute against, no per-gen cost ceiling) a tip
 *     scope would be effectively unbounded spend, so it remains rejected.
 *   - `buzz:read:self` — balance read isn't needed to spend a bounded budget,
 *     and a page (entity=none) has no reason to read the viewer's balance.
 */
export const PAGE_FORBIDDEN_SCOPES = ['buzz:read:self', 'social:tip:self'] as const;

/** Does the slot render a full standalone page (W10)? */
export function isPageSlot(id: string): boolean {
  return isKnownSlotId(id) && SLOT_REGISTRY[id].kind === 'page';
}

/**
 * LAUNCH ALLOWLIST — the slot ids exposed to the PUBLIC (non-moderator) audience
 * at the initial App Blocks public launch.
 *
 * WHY: the initial launch ships the full-page app surface (`app.page`) ONLY. The
 * three model-page slots (`model.sidebar_top` / `model.below_images` /
 * `model.actions_extra`) are NOT part of the public launch — they remain
 * MOD-ONLY for testing/dog-fooding (e.g. the live `generate-from-model` block)
 * until a later product decision widens them. So this is a PUBLIC-audience
 * restriction layered on top of the existing `features.appBlocks` flag gate:
 * moderators are unaffected (they see/install/mint every slot, grandfathering
 * the existing mod-only model-slot usage); non-mods are scoped to launch slots.
 *
 * This is the SINGLE SOURCE OF TRUTH for "what's in the public launch". Widening
 * the launch surface later (e.g. graduating a model slot to public) is ONE edit
 * here — every enforcement point (public marketplace reads, the model-slot
 * install path, the token mint belt) calls `isLaunchSlot` rather than hardcoding
 * `'app.page'`.
 */
export const LAUNCH_SLOT_IDS = ['app.page'] as const;

export type LaunchSlotId = (typeof LAUNCH_SLOT_IDS)[number];

/**
 * Is `id` a slot exposed to the public (non-mod) audience at launch? See
 * {@link LAUNCH_SLOT_IDS}. A non-mod caller may only browse / install / mint
 * apps whose slot satisfies this; a moderator is exempt (grandfathered).
 */
export function isLaunchSlot(id: string): boolean {
  return (LAUNCH_SLOT_IDS as readonly string[]).includes(id);
}
