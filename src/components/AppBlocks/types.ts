/**
 * App Blocks — type definitions shared between the host (this app) and the
 * registry payload returned by `blocks.listForModel`. See
 * docs/features/app-blocks.md for the architecture overview.
 */

export interface SlotContext {
  slotId: string;
  [key: string]: unknown;
}

export interface ModelSlotContext extends SlotContext {
  slotId: 'model.sidebar_top' | 'model.below_images' | 'model.actions_extra';
  modelId: number;
  modelVersionId: number;
  modelName: string;
  modelType: string;
  modelNsfwLevel: number;
  creatorUserId: number;
  viewerUserId: number | null;
  viewerNsfwEnabled: boolean;
  viewerUsername?: string | null;
  /** Coarse status surface for the iframe — authoritative re-check is /api/v1/blocks/me. */
  viewerStatus?: 'active' | 'banned' | 'muted';
  /** Host-page color scheme — lets the iframe match without a flicker. */
  theme?: 'light' | 'dark';
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
    status: 'active' | 'banned' | 'muted';
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
  manifest: BlockManifest;
  publisherSettings: Record<string, unknown>;
  enabled: boolean;
  renderMode: 'iframe' | 'inline';
  trustTier: 'unverified' | 'verified' | 'internal';
}
