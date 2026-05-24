import { dbRead, dbWrite } from '~/server/db/client';
import { redis, REDIS_KEYS, REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import {
  blockSettingsSchemaByBlockId,
  blockUserSettingsSchema,
  type BlockUserSettings,
} from '~/server/schema/blocks/settings.schema';
import { BlockRevocation } from '~/server/services/block-revocation.service';
import {
  getPopularCheckpointForEcosystem,
  getRepresentativeBaseModel,
  validateBlockCheckpoint,
} from '~/server/services/blocks/checkpoint.service';
import {
  newBlockInstanceId,
  newBlockUserSubscriptionId,
  newModelBlockInstallId,
} from '~/server/utils/app-block-ids';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import type {
  AvailableBlock,
  ListAvailableInput,
  SubscriptionRecord,
  SubscriptionScope,
} from '~/server/schema/blocks/subscription.schema';

const CACHE_TTL_SECONDS = 60;
export const MAX_BLOCKS_PER_SLOT = 3;

export interface BlockInstallRecord {
  blockInstanceId: string;
  blockId: string;
  appId: string;
  manifest: {
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
  };
  publisherSettings: Record<string, unknown>;
  enabled: boolean;
  renderMode: 'iframe' | 'inline';
  trustTier: 'unverified' | 'verified' | 'internal';
  /**
   * Publisher-configured default Checkpoint, joined from settings.
   * `defaultCheckpointVersionId` at write time. Anon-safe: contains no
   * user-specific information — the per-viewer override is delivered
   * through a separate session-gated query.
   * `null` when the publisher hasn't set one (LoRA installs that haven't
   * been configured yet) — also the case for misconfigured Checkpoint
   * installs that should never need this anyway.
   */
  defaultCheckpoint?: {
    versionId: number;
    modelId: number;
    modelName: string;
    versionName: string;
    baseModel: string;
  } | null;
}

interface ListForModelOpts {
  modelId: number;
  slotId: string;
  /**
   * The model's type (e.g. 'Checkpoint', 'LORA') used to filter platform
   * defaults whose `target_model_types` array constrains them. Optional —
   * when omitted, platform defaults with target_model_types are skipped
   * (fail-closed).
   */
  modelType?: string;
  /**
   * Model's NSFW level (browsingLevel.constants.ts ladder). Used to drop
   * blocks whose manifest.contentRating exceeds what's allowed for this
   * page. Omitting it defaults to the most restrictive ladder rung ('pg').
   */
  modelNsfwLevel?: number;
}

// Ordered ratings for ladder comparisons. Each rating implies "and below."
// A block rated 'pg13' may render when the slot rating is 'pg13', 'r', or 'x';
// it must not render when the slot rating is 'g' or 'pg'.
const CONTENT_RATING_ORDER = ['g', 'pg', 'pg13', 'r', 'x'] as const;
type ContentRating = (typeof CONTENT_RATING_ORDER)[number];
const CONTENT_RATING_INDEX: Record<string, number> = Object.fromEntries(
  CONTENT_RATING_ORDER.map((r, i) => [r, i])
);

/**
 * Maps a model's NSFW level (browsingLevel.constants.ts ladder, powers of 2
 * starting at 1) to a content-rating cap. The exact mapping mirrors what
 * the model-card UI shows; revisit alongside the next NSFW-level redesign.
 *
 *  level 1   (PG)   → 'pg'
 *  level 2   (PG13) → 'pg13'
 *  level 4   (R)    → 'r'
 *  level 8+  (X+)   → 'x'
 *  default          → 'g' (most restrictive)
 */
function maxRatingForNsfwLevel(level: number | undefined): ContentRating {
  if (!level || level <= 1) return 'pg';
  if (level === 2) return 'pg13';
  if (level === 4) return 'r';
  if (level >= 8) return 'x';
  return 'g';
}

interface InstallOpts {
  modelId: number;
  appBlockId: string;
  slotId: string;
  installedByUserId: number;
  settings?: Record<string, unknown>;
}

interface UninstallOpts {
  modelId: number;
  appBlockId: string;
  slotId: string;
}

interface ToggleOpts {
  modelId: number;
  appBlockId: string;
  slotId: string;
  enabled: boolean;
}

interface UpdateSettingsOpts {
  blockInstanceId: string;
  /**
   * Server-resolved modelId. Audit B3: the previous `updateMany` keyed only
   * on blockInstanceId would, under the B2 TOCTOU window, let a former owner
   * write to an install on a model they no longer own. Pinning modelId in
   * the WHERE means even a stale auth window can't cross models.
   */
  modelId: number;
  settings: Record<string, unknown>;
}

type BlockRegistryKey = `${typeof REDIS_KEYS.BLOCKS.REGISTRY}:${number}:${string}`;

function cacheKey(modelId: number, slotId: string): BlockRegistryKey {
  return `${REDIS_KEYS.BLOCKS.REGISTRY}:${modelId}:${slotId}`;
}

async function invalidateModelCache(modelId: number) {
  const pattern = `${REDIS_KEYS.BLOCKS.REGISTRY}:${modelId}:*`;
  try {
    for await (const batch of redis.scanIterator({ MATCH: pattern, COUNT: 100 })) {
      const keys = (Array.isArray(batch) ? batch : [batch]) as BlockRegistryKey[];
      if (keys.length === 0) continue;
      await redis.del(keys);
    }
  } catch {
    // fail open — cache will expire within CACHE_TTL_SECONDS
  }
}

// M3 (audit-10): every listForModel call does a fresh sysRedis sMembers
// round-trip — and a model page renders multiple slots concurrently, so
// each render hits sysRedis once per slot. The kill list itself is tiny
// and changes only on explicit ops action; a 5s in-process cache trims
// the steady-state load without compromising the emergency-revocation
// latency users actually care about.
const KILL_LIST_CACHE_TTL_MS = 5_000;
type KillListCache = { value: Set<string>; expiresAt: number };
let killListCache: KillListCache | null = null;

async function getKillList(): Promise<Set<string>> {
  const now = Date.now();
  const cached = killListCache;
  if (cached && cached.expiresAt > now) return cached.value;
  try {
    const members = await sysRedis.sMembers(REDIS_SYS_KEYS.BLOCKS.EMERGENCY_KILL_LIST);
    const value = new Set(members ?? []);
    killListCache = { value, expiresAt: now + KILL_LIST_CACHE_TTL_MS };
    return value;
  } catch (err) {
    // M-7 (audit): the emergency kill switch is the ops tool for an
    // already-launched runaway block. If sysRedis is unreachable, the
    // *correct* fail mode is loud, not silent. We can't synchronously
    // page from this hot path, so the next best thing is a console.error
    // (Axiom-collected) and a special sentinel that callers treat as
    // "suppress everything" — i.e. fail-closed. The launch-time feature
    // flag and per-block kill list serve complementary roles; on a
    // kill-list outage the block surface vanishes for the cache TTL
    // window (60s) until sysRedis recovers.
    // eslint-disable-next-line no-console
    console.error('[BlockRegistry] kill-list unreachable; failing closed', err);
    return new Set(['__KILL_LIST_UNREACHABLE__']);
  }
}

function resolveRenderMode(
  manifestRenderMode: string | undefined,
  blockRenderMode: string,
  trustTier: string
): 'iframe' | 'inline' {
  // The app_blocks.render_mode column is authoritative — it's set at
  // manifest registration time after the validator has gated trust tier ×
  // render mode. The manifest.renderMode field is informational only
  // (carried into the iframe via BLOCK_INIT for blocks that want to know
  // how they were dispatched). If the two disagree, the column wins.
  //
  // Per spec §2.10: inline only allowed for verified/internal trust tier.
  // Hybrid resolves to inline only when allowed; otherwise falls back to iframe.
  const requested = manifestRenderMode ?? blockRenderMode ?? 'iframe';
  const allowsInline = trustTier === 'verified' || trustTier === 'internal';
  if ((requested === 'inline' || requested === 'hybrid') && allowsInline) return 'inline';
  return 'iframe';
}

/**
 * Block Registry — queries enabled block installs for a (modelId, slotId)
 * combination, applies the emergency kill list, and caches in Redis for 60s.
 *
 * Publisher Opt-Out invariant (plan §4):
 *   The NOT EXISTS subquery against `model_block_installs` checks
 *   `model_id` + `app_block_id` ONLY — never `enabled`. This is what makes
 *   `toggleEnabled(false)` an opt-out mechanism instead of a no-op.
 */
export class BlockRegistry {
  static async listForModel(opts: ListForModelOpts): Promise<BlockInstallRecord[]> {
    const { modelId, slotId, modelType, modelNsfwLevel } = opts;
    const maxRating = maxRatingForNsfwLevel(modelNsfwLevel);
    const maxRatingIdx = CONTENT_RATING_INDEX[maxRating];
    const key = cacheKey(modelId, slotId);

    try {
      const cached = await redis.packed.get<BlockInstallRecord[]>(key);
      if (cached) {
        const kill = await getKillList();
        // M-7: sentinel from getKillList() means sysRedis is unreachable;
        // suppress everything on this branch (cached path).
        if (kill.has('__KILL_LIST_UNREACHABLE__')) return [];
        return kill.size === 0 ? cached : cached.filter((r) => !kill.has(r.blockId));
      }
    } catch {
      // fail open — fall through to DB
    }

    type Row = {
      block_instance_id: string;
      block_id: string;
      app_id: string;
      manifest: unknown;
      settings: unknown;
      enabled: boolean;
      render_mode: string;
      trust_tier: string;
      manifest_render_mode: string | null;
    };
    // SQL notes:
    //   - installs are scoped to a single slot via mbi.slot_id; the NOT
    //     EXISTS subquery matches (model, app_block, slot) so an opt-out
    //     in slot A does NOT suppress the same block in slot B.
    //   - INVARIANT (see plan §4): do NOT add "AND enabled = true" inside
    //     the NOT EXISTS — that turns toggleEnabled(false) into a no-op.
    //   - I13: platform_default_blocks rows now filter on target_model_types
    //     (when set), and the union orders by priority (lower=earlier) within
    //     each source rank. Installs always rank first (source_rank=1).
    //   - I15: content-rating filter happens in JS after the row map (the
    //     manifest's contentRating lives in JSONB and is easier to compare
    //     in TS against CONTENT_RATING_ORDER than via SQL).
    const rows = (await dbRead.$queryRaw<Row[]>`
      SELECT * FROM (
        SELECT
          mbi.block_instance_id,
          ab.block_id,
          ab.app_id,
          ab.manifest,
          mbi.settings,
          mbi.enabled,
          ab.render_mode,
          ab.trust_tier,
          (ab.manifest->>'renderMode') AS manifest_render_mode,
          1 AS source_rank,
          0 AS priority
        FROM model_block_installs mbi
        JOIN app_blocks ab ON ab.id = mbi.app_block_id
        WHERE mbi.model_id = ${modelId}
          AND mbi.slot_id = ${slotId}
          AND mbi.enabled = TRUE
          AND ab.status = 'approved'

        UNION ALL

        SELECT
          'pdb_' || pdb.app_block_id AS block_instance_id,
          ab.block_id,
          ab.app_id,
          ab.manifest,
          '{}'::jsonb AS settings,
          TRUE AS enabled,
          ab.render_mode,
          ab.trust_tier,
          (ab.manifest->>'renderMode') AS manifest_render_mode,
          2 AS source_rank,
          pdb.priority AS priority
        FROM platform_default_blocks pdb
        JOIN app_blocks ab ON ab.id = pdb.app_block_id
        WHERE pdb.slot_id = ${slotId}
          AND pdb.enabled = TRUE
          AND ab.status = 'approved'
          -- H1 (audit-10): pass NULL when modelType is omitted so the ANY
          -- arm cannot match. The prior coalesce-to-empty-string version
          -- accidentally became an exact-match against the empty string,
          -- which would have leaked any row whose target_model_types
          -- array contained an empty string entry. See block-registry
          -- service header for the full rationale.
          AND (
            pdb.target_model_types IS NULL
            OR array_length(pdb.target_model_types, 1) IS NULL
            OR (
              ${modelType ?? null}::text IS NOT NULL
              AND ${modelType ?? null}::text = ANY(pdb.target_model_types)
            )
          )
          AND NOT EXISTS (
            SELECT 1 FROM model_block_installs
            WHERE model_id = ${modelId}
              AND app_block_id = pdb.app_block_id
              AND slot_id = ${slotId}
          )
      ) combined
      -- M1 (audit-10): add a deterministic tiebreaker. Installs share
      -- priority=0 (hardcoded), so without installed_at Postgres is free
      -- to return them in any order — and the order can change after a
      -- vacuum. Publishers see this as flicker. block_instance_id is
      -- stable + sortable; using it on the installs branch and priority
      -- on the platform-default branch gives us reproducible ordering.
      ORDER BY source_rank ASC, priority ASC, block_instance_id ASC
      LIMIT ${MAX_BLOCKS_PER_SLOT}
    `) as Row[];

    const kill = await getKillList();
    // M-7: kill-list outage → suppress all blocks on this slot for the
    // cache TTL window.
    if (kill.has('__KILL_LIST_UNREACHABLE__')) return [];
    // Inline carry-through type — the post-map needs raw settings to batch
    // the checkpoint lookup, but those never reach the wire (stripped at
    // the final map below).
    type IntermediateRecord = BlockInstallRecord & { _rawSettings: Record<string, unknown> };
    const result: IntermediateRecord[] = rows
      .filter((r: Row) => !kill.has(r.block_id))
      // I15: drop blocks whose manifest.contentRating exceeds the slot's
      // allowed ceiling. An x-rated block must never render on a pg page.
      // Default to most restrictive ('g') if the manifest is missing it.
      .filter((r: Row) => {
        const m = (r.manifest ?? {}) as { contentRating?: unknown };
        const rating =
          typeof m.contentRating === 'string' && m.contentRating in CONTENT_RATING_INDEX
            ? m.contentRating
            : 'g';
        return CONTENT_RATING_INDEX[rating] <= maxRatingIdx;
      })
      .map((r: Row) => {
        // Explicit projection — the manifest JSONB can carry assetBundleUrl,
        // requiredContext, server-internal hints, etc. that we never want
        // returned to anonymous viewers. Echo only the fields the iframe
        // host actually consumes.
        const m = (r.manifest ?? {}) as Record<string, unknown>;
        const iframeRaw = (m.iframe ?? {}) as Record<string, unknown>;
        const manifest: BlockInstallRecord['manifest'] = {
          iframe: iframeRaw.src
            ? {
                src: String(iframeRaw.src),
                minHeight: typeof iframeRaw.minHeight === 'number' ? iframeRaw.minHeight : 200,
                maxHeight:
                  iframeRaw.maxHeight == null
                    ? null
                    : typeof iframeRaw.maxHeight === 'number'
                    ? iframeRaw.maxHeight
                    : null,
                resizable: iframeRaw.resizable === true,
                sandbox:
                  typeof iframeRaw.sandbox === 'string' ? iframeRaw.sandbox : 'allow-scripts',
              }
            : undefined,
          scopes: Array.isArray(m.scopes)
            ? (m.scopes.filter((s) => typeof s === 'string') as string[])
            : undefined,
          contentRating: typeof m.contentRating === 'string' ? m.contentRating : undefined,
          name: typeof m.name === 'string' ? m.name : undefined,
          renderMode:
            m.renderMode === 'iframe' || m.renderMode === 'inline' || m.renderMode === 'hybrid'
              ? m.renderMode
              : undefined,
        };
        // H-3: project publisher settings through the manifest's
        // `publicSettingsKeys` allowlist. Settings is JSONB, no shape
        // guarantee, and listForModel is public — without the allowlist
        // anything a publisher tucks in here leaks to anonymous viewers.
        // Default to empty (fail-closed) when the manifest doesn't declare
        // any public keys; a publisher who wants to expose a key must
        // explicitly list it in their manifest.
        const publicKeys = Array.isArray(m.publicSettingsKeys)
          ? (m.publicSettingsKeys.filter((k) => typeof k === 'string') as string[])
          : [];
        const rawSettings = (r.settings ?? {}) as Record<string, unknown>;
        const publisherSettings: Record<string, unknown> = {};
        for (const k of publicKeys) {
          if (Object.prototype.hasOwnProperty.call(rawSettings, k)) {
            publisherSettings[k] = rawSettings[k];
          }
        }
        // Carry the raw settings forward (separately from publisherSettings
        // which is publicly-projected) so the post-map step below can read
        // `default_checkpoint_version_id` to batch the ModelVersion lookup.
        // The raw settings never make it into the returned record.
        return {
          blockInstanceId: r.block_instance_id,
          blockId: r.block_id,
          appId: r.app_id,
          manifest,
          publisherSettings,
          enabled: r.enabled,
          renderMode: resolveRenderMode(
            r.manifest_render_mode ?? undefined,
            r.render_mode,
            r.trust_tier
          ),
          trustTier: (r.trust_tier as BlockInstallRecord['trustTier']) ?? 'unverified',
          _rawSettings: rawSettings,
        };
      });

    // Single batched join to populate `defaultCheckpoint`. Collect every
    // numeric default_checkpoint_version_id we see across all install rows,
    // do one IN-query, then hydrate per row. Avoids N+1 lookups across
    // installs even though MAX_BLOCKS_PER_SLOT caps us at 3 today.
    const checkpointIds = result
      .map((r) => {
        const id = (r._rawSettings as { default_checkpoint_version_id?: unknown })
          .default_checkpoint_version_id;
        return typeof id === 'number' ? id : null;
      })
      .filter((x): x is number => x != null);
    const checkpointMap = new Map<
      number,
      {
        versionId: number;
        modelId: number;
        modelName: string;
        versionName: string;
        baseModel: string;
      }
    >();
    if (checkpointIds.length > 0) {
      const rows = await dbRead.modelVersion.findMany({
        where: { id: { in: checkpointIds }, status: 'Published' },
        select: {
          id: true,
          name: true,
          baseModel: true,
          modelId: true,
          model: { select: { name: true, type: true } },
        },
      });
      for (const row of rows) {
        // Defensive: skip rows that don't actually point at a Checkpoint —
        // publisher's stored value is stale (model type changed since
        // install). Drop the field rather than misrepresent it to the iframe.
        if (row.model.type !== 'Checkpoint') continue;
        checkpointMap.set(row.id, {
          versionId: row.id,
          modelId: row.modelId,
          modelName: row.model.name,
          versionName: row.name,
          baseModel: row.baseModel,
        });
      }
    }
    const hydrated: BlockInstallRecord[] = result.map((r) => {
      const rawId = (r._rawSettings as { default_checkpoint_version_id?: unknown })
        .default_checkpoint_version_id;
      const checkpointId = typeof rawId === 'number' ? rawId : null;
      const defaultCheckpoint =
        checkpointId != null ? checkpointMap.get(checkpointId) ?? null : null;
      const { _rawSettings: _unused, ...rest } = r;
      return { ...rest, defaultCheckpoint };
    });

    try {
      await redis.packed.set(key, hydrated, { EX: CACHE_TTL_SECONDS });
    } catch {
      // fail open
    }

    return hydrated;
  }

  static async installOnModel(opts: InstallOpts): Promise<{ blockInstanceId: string }> {
    const { modelId, appBlockId, slotId, installedByUserId, settings } = opts;

    // Use dbWrite for the status check to avoid a replication-lag window
    // where a freshly-suspended block could still be installed. Also
    // SELECT blockId so we can look up the per-block settings schema.
    const block = await dbWrite.appBlock.findUnique({
      where: { id: appBlockId },
      select: { status: true, blockId: true },
    });
    // throwNotFoundError/throwBadRequestError throw at runtime, but their
    // signatures return `void`, so TS can't narrow `block` here. Hand-narrow.
    if (!block) throw throwNotFoundError('App block not found') as never;
    if (block.status !== 'approved') {
      throw throwBadRequestError('App block is not approved') as never;
    }

    // Per-block-id settings validation. Generic settingsSchema (size + JSON)
    // has already run at the router; this layer enforces the typed shape
    // and cross-row checks (e.g. checkpoint ecosystem match). External
    // (un-first-party) blocks fall through without typed validation.
    const validatedSettings = await validateInstallSettings({
      blockId: block.blockId,
      settings,
      forModelId: modelId,
    });

    // H-4: enforce the per-slot cap at install time. listForModel LIMITs to
    // MAX_BLOCKS_PER_SLOT in SQL, but the prior implementation silently
    // accepted any number of installs — the 4th publisher saw success but
    // their block never rendered. Reject explicitly so the caller knows.
    //
    // The count below could race with a concurrent install; we accept that
    // and let the create branch hit the composite UNIQUE if it does. The
    // race window is tiny (one Redis-cached findMany), and the worst case
    // is the 4th install lands and the SQL LIMIT continues to truncate.
    // The upsert branch (same publisher re-installing same slot) doesn't
    // need this check because it doesn't grow the count.
    const existingForSlot = await dbWrite.modelBlockInstall.findMany({
      where: { modelId, slotId },
      select: { appBlockId: true },
    });
    const alreadyInstalled = existingForSlot.some(
      (r: { appBlockId: string }) => r.appBlockId === appBlockId
    );
    if (!alreadyInstalled && existingForSlot.length >= MAX_BLOCKS_PER_SLOT) {
      throwBadRequestError(
        `Slot ${slotId} already has the maximum of ${MAX_BLOCKS_PER_SLOT} installs`
      );
    }

    // Atomic upsert keyed on the composite unique. Two concurrent install
    // double-clicks both target the same key; Prisma upsert serializes them,
    // so one runs `create` and the other runs `update` — neither hits a
    // UNIQUE violation. The `create` branch's blockInstanceId is only
    // consumed when no row exists; the `update` branch preserves the
    // existing id via the SELECT.
    //
    // M2: omitting `settings` in the update branch preserves prior values.
    // Pre-fix, an `installOnModel({modelId, appBlockId, slotId})` call
    // without `settings` wiped the publisher's existing settings to {}.
    const candidate = newBlockInstanceId();
    const updateData: {
      enabled: boolean;
      updatedAt: Date;
      settings?: object;
    } = {
      enabled: true,
      updatedAt: new Date(),
    };
    if (validatedSettings != null) updateData.settings = validatedSettings;

    const result = await dbWrite.modelBlockInstall.upsert({
      where: { modelId_appBlockId_slotId: { modelId, appBlockId, slotId } },
      create: {
        id: newModelBlockInstallId(),
        modelId,
        appBlockId,
        slotId,
        blockInstanceId: candidate,
        installedByUserId,
        settings: (validatedSettings ?? {}) as object,
        enabled: true,
      },
      update: updateData,
      select: { blockInstanceId: true },
    });

    await invalidateModelCache(modelId);
    return { blockInstanceId: result.blockInstanceId };
  }

  static async uninstallFromModel(opts: UninstallOpts): Promise<void> {
    const { modelId, appBlockId, slotId } = opts;
    // Capture the affected blockInstanceId BEFORE deleteMany so we can
    // write the revocation marker. Otherwise a token issued seconds before
    // uninstall stays valid against the consumer routes until natural exp.
    const rows: { blockInstanceId: string }[] = await dbWrite.modelBlockInstall.findMany({
      where: { modelId, appBlockId, slotId },
      select: { blockInstanceId: true },
    });
    await dbWrite.modelBlockInstall.deleteMany({
      where: { modelId, appBlockId, slotId },
    });
    for (const { blockInstanceId } of rows) {
      await BlockRevocation.revokeInstance(blockInstanceId);
    }
    await invalidateModelCache(modelId);
  }

  static async toggleEnabled(opts: ToggleOpts): Promise<void> {
    const { modelId, appBlockId, slotId, enabled } = opts;
    const row = await dbWrite.modelBlockInstall.update({
      where: { modelId_appBlockId_slotId: { modelId, appBlockId, slotId } },
      data: { enabled, updatedAt: new Date() },
      select: { blockInstanceId: true },
    });
    // Disable writes a revocation marker; re-enable MUST clear it. Without
    // the clear, every freshly-minted token for this install would be
    // rejected by withBlockScope until the marker's 15-minute TTL elapsed
    // (the blockInstanceId is preserved across toggle).
    if (enabled) {
      await BlockRevocation.clearInstance(row.blockInstanceId);
    } else {
      await BlockRevocation.revokeInstance(row.blockInstanceId);
    }
    await invalidateModelCache(modelId);
  }

  static async updateSettings(opts: UpdateSettingsOpts): Promise<void> {
    const { blockInstanceId, modelId, settings } = opts;
    // Look up the install + its app block so we can run per-block typed
    // validation. The blockInstanceId+modelId pair is the auth pin; if it
    // doesn't match the not-found path below fires.
    const install = await dbWrite.modelBlockInstall.findFirst({
      where: { blockInstanceId, modelId },
      select: { appBlock: { select: { blockId: true } } },
    });
    if (!install) throwNotFoundError('Block install not found');

    const validatedSettings = await validateInstallSettings({
      blockId: install!.appBlock.blockId,
      settings,
      forModelId: modelId,
    });

    // B3: pin modelId in the predicate. updateMany returns count 0 when
    // the install moved to a different model between auth check and write,
    // which we then surface as not-found instead of silently writing to a
    // model the caller no longer owns.
    const result = await dbWrite.modelBlockInstall.updateMany({
      where: { blockInstanceId, modelId },
      data: { settings: (validatedSettings ?? {}) as object, updatedAt: new Date() },
    });
    if (result.count === 0) {
      throwNotFoundError('Block install not found');
    }
    await invalidateModelCache(modelId);
  }

  /**
   * Upsert the per-viewer settings row for a (blockInstanceId, userId) pair.
   * Used by `blocks.updateUserSettings` for things like the per-user
   * checkpoint override. Validation (ecosystem match etc.) is the caller's
   * responsibility — the registry method just writes.
   */
  static async upsertUserSettings(opts: {
    blockInstanceId: string;
    userId: number;
    settings: BlockUserSettings;
  }): Promise<void> {
    const { blockInstanceId, userId, settings } = opts;
    await dbWrite.blockUserSettings.upsert({
      where: { blockInstanceId_userId: { blockInstanceId, userId } },
      create: {
        blockInstanceId,
        userId,
        settings: settings as object,
      },
      update: {
        settings: settings as object,
        updatedAt: new Date(),
      },
    });
  }

  /**
   * Read the per-viewer settings row, if any. Returns the raw shape so
   * callers can merge it with publisher defaults as they see fit. Returns
   * null when the viewer has never set anything (including for anon).
   */
  static async getUserSettings(opts: {
    blockInstanceId: string;
    userId: number;
  }): Promise<BlockUserSettings | null> {
    const row = await dbRead.blockUserSettings.findUnique({
      where: { blockInstanceId_userId: opts },
      select: { settings: true },
    });
    if (!row) return null;
    return row.settings as BlockUserSettings;
  }

  /**
   * Compute the effective checkpoint info for a (blockInstanceId, viewer)
   * pair — the merge of publisher default ∪ viewer override resolved into
   * the BlockCheckpointInfo shape the iframe consumes.
   *
   * Used by the IframeHost to populate `BLOCK_INIT.context.checkpoint`
   * BEFORE sending init. Anon viewers (`userId == null`) get the publisher
   * default; authenticated viewers get their override if set.
   *
   * Returns `null` when no checkpoint is configured (rare — install form
   * enforces a publisher default for LoRA installs at write time) AND the
   * bound model isn't itself a Checkpoint.
   */
  static async getEffectiveCheckpoint(opts: {
    blockInstanceId: string;
    userId: number | null;
  }): Promise<{
    versionId: number;
    modelId: number;
    modelName: string;
    versionName: string;
    baseModel: string;
  } | null> {
    const { blockInstanceId, userId } = opts;

    // Pull the install (with its bound model) + the per-viewer settings
    // row (only when authenticated) in parallel.
    const [install, viewerRow] = await Promise.all([
      dbRead.modelBlockInstall.findUnique({
        where: { blockInstanceId },
        select: {
          settings: true,
          modelId: true,
          modelVersionId: true,
          model: { select: { id: true, name: true, type: true } },
        },
      }),
      userId != null
        ? dbRead.blockUserSettings.findUnique({
            where: { blockInstanceId_userId: { blockInstanceId, userId } },
            select: { settings: true },
          })
        : Promise.resolve(null),
    ]);
    if (!install) return null;

    // Checkpoint-bound install: the model is its own anchor. Skip the
    // override path entirely — v1 decision keeps Checkpoint installs atomic.
    if (install.model.type === 'Checkpoint') {
      // We need the version row to fill versionName/baseModel. Pick the
      // install's modelVersionId if pinned, else most-recent Published.
      const versionRow = install.modelVersionId
        ? await dbRead.modelVersion.findUnique({
            where: { id: install.modelVersionId },
            select: { id: true, name: true, baseModel: true },
          })
        : await dbRead.modelVersion.findFirst({
            where: { modelId: install.modelId, status: 'Published' },
            orderBy: { createdAt: 'desc' },
            select: { id: true, name: true, baseModel: true },
          });
      if (!versionRow) return null;
      return {
        versionId: versionRow.id,
        modelId: install.modelId,
        modelName: install.model.name,
        versionName: versionRow.name,
        baseModel: versionRow.baseModel,
      };
    }

    // Compute the candidate checkpoint id via the same precedence chain as
    // resolveBlockCheckpoint, then do a single ModelVersion lookup.
    const viewerSettings = blockUserSettingsSchema.safeParse(viewerRow?.settings ?? {});
    const overrideId = viewerSettings.success
      ? viewerSettings.data.checkpoint_version_id
      : undefined;
    const publisherSchema = blockSettingsSchemaByBlockId['generate-from-model'];
    const publisherSettings = publisherSchema.safeParse(install.settings ?? {});
    const publisherId = publisherSettings.success
      ? (publisherSettings.data as { default_checkpoint_version_id?: number })
          .default_checkpoint_version_id
      : undefined;
    const candidate = typeof overrideId === 'number' ? overrideId : publisherId;
    if (typeof candidate === 'number') {
      const row = await dbRead.modelVersion.findUnique({
        where: { id: candidate },
        select: {
          id: true,
          name: true,
          baseModel: true,
          status: true,
          modelId: true,
          model: { select: { name: true, type: true } },
        },
      });
      // Quietly accept the candidate when valid. If it's stale (deleted /
      // unpublished / mistyped) fall through to the platform default below
      // rather than show "missing checkpoint" — the block can still mount
      // with a sensible label.
      if (row && row.status === 'Published' && row.model.type === 'Checkpoint') {
        return {
          versionId: row.id,
          modelId: row.modelId,
          modelName: row.model.name,
          versionName: row.name,
          baseModel: row.baseModel,
        };
      }
    }

    // Platform per-ecosystem fallback. Need the LoRA's baseModel to pick
    // the family — read the install's version (or representative version
    // if not pinned). This matches what resolveBlockCheckpoint does at
    // submit time, so BLOCK_INIT and submit agree on the same default.
    const loraVersion = install.modelVersionId
      ? await dbRead.modelVersion.findUnique({
          where: { id: install.modelVersionId },
          select: { baseModel: true },
        })
      : await dbRead.modelVersion.findFirst({
          where: { modelId: install.modelId, status: 'Published' },
          orderBy: { createdAt: 'desc' },
          select: { baseModel: true },
        });
    if (loraVersion?.baseModel) {
      const popular = await getPopularCheckpointForEcosystem(loraVersion.baseModel);
      if (popular) {
        return {
          versionId: popular.versionId,
          modelId: popular.modelId,
          modelName: popular.modelName,
          versionName: popular.versionName,
          baseModel: popular.baseModel,
        };
      }
    }
    return null;
  }

  /**
   * Returns every active subscription row for a user (both scopes), with
   * the app_block row denormalised for management-UI rendering. Ordered by
   * most recently updated first so the user sees their latest changes at
   * the top of the list.
   */
  static async listUserSubscriptions(userId: number): Promise<SubscriptionRecord[]> {
    const rows = await dbRead.blockUserSubscription.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        scope: true,
        appBlockId: true,
        targetModelTypes: true,
        targetBaseModels: true,
        settings: true,
        enabled: true,
        createdAt: true,
        updatedAt: true,
        appBlock: {
          select: {
            blockId: true,
            appId: true,
            manifest: true,
          },
        },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      scope: row.scope as SubscriptionScope,
      appBlockId: row.appBlockId,
      blockId: row.appBlock.blockId,
      appId: row.appBlock.appId,
      // The arrays are NOT NULL in the DB (Prisma drops nullability for
      // String[]). An empty array means "applies to everything"; surface
      // that as `null` for the wire shape so the UI logic stays simple.
      targetModelTypes:
        row.targetModelTypes && row.targetModelTypes.length > 0 ? row.targetModelTypes : null,
      targetBaseModels:
        row.targetBaseModels && row.targetBaseModels.length > 0 ? row.targetBaseModels : null,
      settings: (row.settings ?? {}) as Record<string, unknown>,
      enabled: row.enabled,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      manifest: (row.appBlock.manifest ?? {}) as SubscriptionRecord['manifest'],
    }));
  }

  /**
   * Idempotent upsert against the (userId, appBlockId, scope) composite
   * unique. Two concurrent toggle clicks land at the same key — Prisma
   * serializes the upsert so neither hits a UNIQUE violation. Settings,
   * targets, enabled all overwrite on update (the caller is the source of
   * truth for the whole row).
   */
  static async upsertSubscription(opts: {
    userId: number;
    appBlockId: string;
    scope: SubscriptionScope;
    targetModelTypes: string[] | null;
    targetBaseModels: string[] | null;
    settings: Record<string, unknown>;
    enabled: boolean;
  }): Promise<SubscriptionRecord> {
    const block = await dbWrite.appBlock.findUnique({
      where: { id: opts.appBlockId },
      select: { id: true, blockId: true, appId: true, status: true, manifest: true },
    });
    if (!block) throw throwNotFoundError('App block not found') as never;
    if (block.status !== 'approved') {
      throw throwBadRequestError('App block is not approved') as never;
    }
    // Empty arrays normalised to an empty TEXT[] in Postgres — the SQL
    // `array_length(... , 1) IS NULL` predicate treats that as "no filter."
    const targetModelTypes = opts.targetModelTypes ?? [];
    const targetBaseModels = opts.targetBaseModels ?? [];

    const candidateId = newBlockUserSubscriptionId();
    const row = await dbWrite.blockUserSubscription.upsert({
      where: {
        userId_appBlockId_scope: {
          userId: opts.userId,
          appBlockId: opts.appBlockId,
          scope: opts.scope,
        },
      },
      create: {
        id: candidateId,
        userId: opts.userId,
        appBlockId: opts.appBlockId,
        scope: opts.scope,
        targetModelTypes,
        targetBaseModels,
        settings: opts.settings as object,
        enabled: opts.enabled,
      },
      update: {
        targetModelTypes,
        targetBaseModels,
        settings: opts.settings as object,
        enabled: opts.enabled,
        updatedAt: new Date(),
      },
      select: {
        id: true,
        scope: true,
        appBlockId: true,
        targetModelTypes: true,
        targetBaseModels: true,
        settings: true,
        enabled: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    // Subscription writes can affect what shows up on any model page the
    // user owns (publisher) or visits (viewer). The model-keyed cache
    // can't be safely invalidated by user id alone, so just-write semantics
    // for v1 rely on cache being disabled when viewerUserId != null and on
    // the 60s TTL for the (modelId, slotId) layer. Document for future.
    return {
      id: row.id,
      scope: row.scope as SubscriptionScope,
      appBlockId: row.appBlockId,
      blockId: block.blockId,
      appId: block.appId,
      targetModelTypes:
        row.targetModelTypes && row.targetModelTypes.length > 0 ? row.targetModelTypes : null,
      targetBaseModels:
        row.targetBaseModels && row.targetBaseModels.length > 0 ? row.targetBaseModels : null,
      settings: (row.settings ?? {}) as Record<string, unknown>,
      enabled: row.enabled,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      manifest: (block.manifest ?? {}) as SubscriptionRecord['manifest'],
    };
  }

  /**
   * Delete a subscription. Owner-only — the userId predicate pins the row
   * so a stolen id can't be deleted by another user. Returns silently when
   * the row doesn't exist (idempotent for retries) but raises authorization
   * when the row exists and belongs to someone else.
   */
  static async deleteSubscription(opts: {
    subscriptionId: string;
    userId: number;
  }): Promise<void> {
    const existing = await dbWrite.blockUserSubscription.findUnique({
      where: { id: opts.subscriptionId },
      select: { userId: true },
    });
    if (!existing) return; // idempotent
    if (existing.userId !== opts.userId) {
      throw throwAuthorizationError('Not the subscription owner') as never;
    }
    await dbWrite.blockUserSubscription.delete({
      where: { id: opts.subscriptionId },
    });
  }

  /**
   * Marketplace listing. Filters by slot (manifest @> {targets:[{slotId}]})
   * and a simple ILIKE on the manifest name/blockId. Cursor is the last
   * row's id (the `app_blocks` primary key sorts deterministically). Sort
   * by install count desc, then id asc — the count is computed at read
   * time via a correlated subquery; at <20 approved blocks this is fine.
   */
  static async listAvailable(
    input: ListAvailableInput
  ): Promise<{ items: AvailableBlock[]; nextCursor?: string }> {
    const { slotId, query, cursor, limit } = input;
    type Row = {
      id: string;
      block_id: string;
      app_id: string;
      app_name: string | null;
      manifest: unknown;
      install_count: bigint;
    };
    const slotFilter = slotId
      ? `{"targets":[{"slotId":"${slotId}"}]}`
      : null;
    const queryLike = query ? `%${query.toLowerCase()}%` : null;
    // The cursor is opaque — we encode `(install_count, id)` so the
    // tiebreaker stays deterministic across pages. For v1 simplicity, the
    // cursor is just the last row's id; the install_count tiebreaker
    // happens naturally because the SQL stays deterministic.
    const rows = await dbRead.$queryRaw<Row[]>`
      SELECT
        ab.id,
        ab.block_id,
        ab.app_id,
        oc.name AS app_name,
        ab.manifest,
        (SELECT COUNT(*)::bigint FROM model_block_installs mbi
         WHERE mbi.app_block_id = ab.id) AS install_count
      FROM app_blocks ab
      LEFT JOIN "OauthClient" oc ON oc.id = ab.app_id
      WHERE ab.status = 'approved'
        AND (
          ${slotFilter}::text IS NULL
          OR ab.manifest @> ${slotFilter}::jsonb
        )
        AND (
          ${queryLike}::text IS NULL
          OR LOWER(COALESCE(ab.manifest->>'name', '')) LIKE ${queryLike}
          OR LOWER(ab.block_id) LIKE ${queryLike}
        )
        AND (${cursor ?? null}::text IS NULL OR ab.id > ${cursor ?? null}::text)
      ORDER BY install_count DESC, ab.id ASC
      LIMIT ${limit + 1}
    `;
    const trimmed = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? trimmed[trimmed.length - 1]?.id : undefined;
    return {
      items: trimmed.map((r) => ({
        id: r.id,
        blockId: r.block_id,
        appId: r.app_id,
        appName: r.app_name ?? null,
        manifest: (r.manifest ?? {}) as Record<string, unknown>,
        installCount: Number(r.install_count),
      })),
      nextCursor,
    };
  }
}

/**
 * Per-block-id settings validation. Generic JSON-shape + size validation
 * happens in the router; this layer enforces the typed fields each
 * first-party block declares + cross-row checks the zod schema can't do
 * (e.g. "the checkpoint must exist + be in the same ecosystem as the LoRA").
 *
 * Returns the parsed settings object (or `undefined` if the caller passed
 * `undefined`). Throws TRPCError on validation failure — propagates to the
 * router, which surfaces it as a structured error the install-form UI can
 * inline. External (un-first-party) blocks skip the typed parse but still
 * have their settings forwarded.
 */
async function validateInstallSettings(opts: {
  blockId: string;
  settings: unknown;
  forModelId: number;
}): Promise<Record<string, unknown> | undefined> {
  const { blockId, settings, forModelId } = opts;
  if (settings == null) return undefined;

  const schema = blockSettingsSchemaByBlockId[blockId];
  // External block: no typed schema, no checkpoint to validate. Forward
  // the generic record through.
  if (!schema) return settings as Record<string, unknown>;

  const parsed = schema.parse(settings) as Record<string, unknown>;

  // Cross-row validation for the checkpoint default. Only first-party
  // blocks expose this key. For un-Checkpoint bound models (LoRA on Flux,
  // etc.) the checkpoint must be in the same family — that gates against
  // a publisher accidentally setting a SDXL checkpoint on a Flux LoRA.
  const checkpointId = parsed.default_checkpoint_version_id;
  if (typeof checkpointId === 'number') {
    const baseModel = await getRepresentativeBaseModel(forModelId);
    if (!baseModel) {
      // No published versions yet — can't validate the ecosystem. Strip
      // the field so the install row stays consistent (a value here that
      // can't be validated later will fail at submit time anyway).
      const { default_checkpoint_version_id: _, ...rest } = parsed;
      return rest;
    }
    await validateBlockCheckpoint({
      checkpointVersionId: checkpointId,
      forBaseModel: baseModel,
      reason: 'publisher-default',
    });
  }

  return parsed;
}
