/**
 * App Blocks — type definitions shared between the host (this app) and the
 * registry payload returned by `blocks.listForModel`. See
 * docs/features/app-blocks.md for the architecture overview.
 */

export interface SlotContext {
  slotId: string;
  [key: string]: unknown;
}

/**
 * Snapshot of the effective Checkpoint the block will generate against —
 * already merged from publisher default + viewer override on the host.
 * For Checkpoint-bound installs this is the model itself; for LoRA installs
 * it's whichever Checkpoint the resolver picked.
 *
 * `null` means no checkpoint is configured (rare in practice — install
 * forms enforce the publisher default at write time). Blocks should render
 * a "missing checkpoint" state in that case.
 */
export interface BlockCheckpointInfo {
  versionId: number;
  modelId: number;
  modelName: string;
  versionName: string;
  baseModel: string;
}

/**
 * One of the model version's curated preview images, with the standard
 * gen params extracted from its meta. Block UIs use these to let the user
 * "remix" a known-good prompt without typing it themselves.
 *
 * `null` on a gen-param field means the source image's meta didn't have
 * that value (or it was malformed) — the block should treat null as "keep
 * the current value" rather than clearing the field.
 */
export interface ShowcaseImage {
  id: number;
  url: string;
  width: number;
  height: number;
  prompt: string | null;
  negativePrompt: string | null;
  cfgScale: number | null;
  steps: number | null;
  seed: number | null;
  sampler: string | null;
  /** Per-resource CLIP layer skip count (SD1/SDXL). Flux ignores it. */
  clipSkip: number | null;
}

/**
 * The entity a slot's context binds to. Drives the entity-aware token mint +
 * binding. Only `model` (the three model slots) and `none` (the W10 page) are
 * used today; `user`/`image` are reserved (Phase 1/2) and intentionally not
 * given a context type yet.
 */
export type SlotEntityType = 'model' | 'none';

export interface ModelSlotContext extends SlotContext {
  slotId: 'model.sidebar_top' | 'model.below_images' | 'model.actions_extra';
  /** Discriminator — present for the entity-aware mint/binding. */
  entityType?: 'model';
  modelId: number;
  modelVersionId: number;
  modelName: string;
  modelType: string;
  modelNsfwLevel: number;
  creatorUserId: number;
  viewerUserId: number | null;
  viewerNsfwEnabled: boolean;
  viewerUsername?: string | null;
  /**
   * Host-internal viewer moderation state. Intentionally NOT forwarded to the
   * iframe (see projectBlockInitViewer) — exposing ban/mute to untrusted
   * publisher code is a privacy leak with no consumer.
   */
  viewerStatus?: 'active' | 'banned' | 'muted';
  /** Host-page color scheme — lets the iframe match without a flicker. */
  theme?: 'light' | 'dark';
  /**
   * Effective Checkpoint after publisher-default ∪ viewer-override merge.
   * `null` when no checkpoint is configured AND the bound model isn't one
   * itself (misconfigured install).
   */
  checkpoint?: BlockCheckpointInfo | null;
  /**
   * Top showcase images for this model version, ordered by all-time
   * reactions. Capped at 6 by the host. Empty array means the version
   * has no preview images yet.
   */
  showcaseImages?: ShowcaseImage[];
}

/**
 * W10 full-page app context (entity=none). A page is PURE viewer-scoped: no
 * model/user/image entity, no money scopes. It carries only the viewer +
 * routing info the block needs to render a full page and deep-link. The host
 * mints the token from a synthetic `page_<appBlockId>` resolved directly from
 * the approved AppBlock — there is no install row (stateless, Decision 2).
 */
export interface PageContext extends SlotContext {
  slotId: 'app.page';
  entityType: 'none';
  /** The block_id slug the page route resolved (`<slug>.civit.ai`). */
  slug: string;
  /** Sub-path under the page route (`/apps/run/<slug>/<...path>`), no leading
   *  slash. Empty string for the page root. Forwarded so the block can deep-link. */
  subPath: string;
  viewerUserId: number | null;
  viewerUsername?: string | null;
  /** Host-page color scheme — lets the iframe match without a flicker. */
  theme?: 'light' | 'dark';
}

/**
 * The union of slot contexts the host can produce. Discriminated by
 * `entityType` (with the model case allowed to omit it for back-compat — model
 * producers predate the discriminator). `none` is the page.
 */
export type BlockSlotContext = ModelSlotContext | PageContext;

/**
 * Entity-agnostic remount key for a BlockSlot mount. Replaces the model-only
 * `${slotId}:${context.modelId}` key. PRESERVES the exact model remount-on-nav
 * behavior (H-4): for a model context the entity id is the modelId, so the key
 * is `${slotId}:model:${modelId}` and still force-unmounts on model navigation.
 * For a page it keys on the slug (`${slotId}:none:<slug>`).
 */
export function slotRemountKey(args: {
  slotId: string;
  entityType: SlotEntityType;
  entityId?: string | number | null;
}): string {
  const { slotId, entityType, entityId } = args;
  return `${slotId}:${entityType}:${entityId ?? 'none'}`;
}

/**
 * SDK BLOCK_INIT contract — the payload the host posts to the iframe once
 * iframe.load AND token are both ready. Matches @civitai/app-sdk/blocks v1.
 * See docs/features/app-blocks.md "BLOCK_INIT contract".
 */
export interface BlockInitPayload {
  blockInstanceId: string;
  blockId: string;
  appId: string;
  /** Wrapped token + metadata so blocks don't have to JWT-decode. */
  token: {
    raw: string;
    scopes: string[];
    expiresAt: string;
    /** Present only when manifest declares ai:write:budgeted. */
    buzzBudget?: number;
  };
  context: SlotContext;
  /** Empty `userSettings` in v1 — Phase 2 wires per-viewer prefs. */
  settings: {
    publisherSettings: Record<string, unknown>;
    userSettings: Record<string, unknown>;
  };
  viewer: {
    id: number;
    username: string | null;
  } | null;
  theme: 'light' | 'dark';
  renderMode: 'iframe' | 'inline';
}

export interface BlockManifest {
  iframe?: {
    src: string;
    minHeight: number;
    maxHeight: number | null;
    resizable: boolean;
    sandbox: string;
  };
  scopes?: string[];
  contentRating?: string;
  name?: string;
  renderMode?: 'iframe' | 'inline' | 'hybrid';
  [key: string]: unknown;
}

export interface BlockInstall {
  blockInstanceId: string;
  blockId: string;
  appId: string;
  /**
   * `app_blocks.id` for this install — distinct from `blockId` (the
   * manifest's block id) and `appId` (the OauthClient id). Required
   * for App Blocks buzz attribution: the publisher revenue-share row
   * stamps the specific app_block row that earned the share.
   */
  appBlockId: string;
  manifest: BlockManifest;
  publisherSettings: Record<string, unknown>;
  enabled: boolean;
  renderMode: 'iframe' | 'inline';
  trustTier: 'unverified' | 'verified' | 'internal';
}
