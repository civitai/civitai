/**
 * Block action detail — the structured, per-action audit payload stored on a
 * `BlockScopeInvocation` row (the nullable `detail` JSON column) and resolved to
 * a human-readable sentence at RENDER time.
 *
 * Design (locked product decisions):
 *   1. MUTATIONS / impactful actions carry FULL structured detail — a stable
 *      `action` code plus minimal subject refs (ids, amounts, keys). NO request
 *      or response bodies, and NO PII beyond ids. The VIEW resolves ids →
 *      display names via the existing batch lookup queries, so the stored row
 *      stays a stable, forward-compatible reference — never a pre-rendered
 *      string that would rot when a name changes.
 *   2. PASSIVE READS get NO write-side change. Their friendly label is derived
 *      purely from the scope string via `READ_SCOPE_LABELS` at render time.
 *
 * Because the payload is `Json?`, a row read back from the DB is `unknown` —
 * always narrow it with `isBlockActionDetail` before use. Old rows (written
 * before this column existed) and reads carry `detail: null` and fall back to
 * the historical `scope · endpoint · status` rendering.
 */

/**
 * Stable action codes. String-typed on the wire (a `detail.action` from an
 * older/newer deploy must render safely rather than throw), but this union is
 * the authoritative set the writers emit and the view knows how to humanise.
 */
export type BlockActionCode =
  | 'tip'
  | 'workflow.submit'
  | 'settings.update'
  | 'storage.set'
  | 'storage.delete'
  | 'storage.increment'
  // The SHARED (cross-user, app-global) storage mutations, reachable over
  // `/api/v1/blocks/shared-storage/{append,update,vote,unvote,withdraw,report}`.
  // Six codes rather than one `storage.shared`, because they are six different
  // consequences — publishing text other users read, editing it, moving a public
  // tally, deleting a row, filing a moderator report — and the audit row's other
  // two columns cannot tell them apart: `scope` is `apps:storage:shared:write`
  // for all six and `endpoint` is only the route name. Distinguishing them is
  // exactly what `detail` exists for.
  | 'shared.append'
  | 'shared.update'
  | 'shared.vote'
  | 'shared.unvote'
  | 'shared.withdraw'
  | 'shared.report'
  | 'post.create';

export type BlockActionDetail = {
  /** Stable action code (see BlockActionCode). Free-form on the wire for fwd-compat. */
  action: string;
  /** Buzz delta for money actions — NEGATIVE for a spend, positive for a credit. */
  amount?: number;
  /** Recipient ref (e.g. a tip target) — resolved to @username by the view. */
  toUserId?: number;
  /**
   * Subject entity the action targeted, as a (type, id) pair — mirrors the tip
   * endpoint's `entityType`/`entityId`. The view resolves a display name from
   * this: `entityType==='ModelVersion'` via the model-version batch lookup, other
   * types render a safe generic subject. (Kept as a generic pair rather than a
   * `modelVersionId` so a single contract covers every entity a mutation names.)
   */
  entityId?: number;
  entityType?: string;
  /** Storage key (already scoped to the user's own namespace). */
  key?: string;
  /**
   * Orchestrator workflow id for a `workflow.submit`. Lives HERE, not in the
   * `endpoint` column: `endpoint` is an AGGREGATION key (the `topEndpoints`
   * rollup groups on it), so embedding a per-submit id there makes the column
   * unbounded and every rollup bucket count 1 — the same cardinality reasoning
   * `boundAppBlockIdLabel` applies to the prom `app_block_id` label. `detail` is
   * the per-row payload ("stores IDS, not display names"), so the Activity
   * panel's Detail column reads the id from here instead of parsing it back out
   * of the endpoint string. Absent when the submit had no id yet (was
   * `workflow:submit:pending`).
   */
  workflowId?: string;
  /** Terminal outcome of the action. */
  outcome?: 'ok' | 'failed';
  /**
   * The App Blocks STEP-TYPE registry id this `workflow.submit` ran
   * (`~/server/services/blocks/steps`) — e.g. `'convert-image'`. Written ONLY by
   * the `kind: 'step'` submit path; ABSENT on a `textToImage` / `customComfy`
   * submit, which is what distinguishes them in the row.
   *
   * 🔴 WHY IT IS HERE AND NOT DERIVED. Nothing else on the row carries it:
   * `scope` is `'ai:write:budgeted'` for every spending kind and `endpoint` is
   * `workflow:submit:<workflowId>`, so before this field a step submit and a
   * txt2img submit were INDISTINGUISHABLE in `block_scope_invocations`, and two
   * different step types were indistinguishable from each other. Per-(user, app,
   * capability) usage accounting was therefore not answerable from this table at
   * all.
   *
   * ⚠️ NO LONGER BOUNDED BY CONSTRUCTION. On the registry arm the value is a
   * registry KEY, which the wire schema derives its `step` enum from
   * (`REGISTERED_STEP_IDS`). The PASS-THROUGH arm writes the submitted
   * orchestrator `$type` here instead, and that is app-supplied text bounded
   * only by `z.string().min(1).max(64)` — deliberately, because on an arm whose
   * type set is open by construction this is the one dimension that makes two
   * submits distinguishable. Nothing reads this field for display today; treat
   * it as untrusted if anything starts to.
   */
  step?: string;
  /**
   * The variant that `workflow.submit` resolved to, for a `kind: 'step'` submit.
   *
   * Bounded to the entry's declared `variants` by `resolveStepVariant` — that
   * wrapper is what makes this safe to persist, not a promise from the entry.
   *
   * 🔴 WHAT THIS IS AND IS NOT, because the obvious reading over-claims. It is
   * the registry's "which variant did this resolve to?" value. It is the MODEL
   * only for an entry that makes its model its variant — the shape recommended
   * for a model-allowlisted entry, and the one per-model pricing forces anyway,
   * but NOT something this field can guarantee about an arbitrary future entry.
   * For `convert-image` today it is always `'default'` and carries no
   * information; it is recorded uniformly so the dimension exists on every step
   * row rather than appearing only once some entry opts in.
   */
  variant?: string;
  /**
   * Number of images in a `post.create`. Bounded by construction
   * (`BLOCK_POST_MAX_IMAGES`), server-counted, never a client claim.
   */
  imageCount?: number;
  /**
   * Gallery target of a `post.create`, when the post was attached to a model
   * version. Present ONLY on an attached post — its ABSENCE is the signal that
   * no model owner was paid, which is exactly the dimension an abuse sweep over
   * this table needs. (The post itself is on `entityType`/`entityId`.)
   */
  modelVersionId?: number;
};

/**
 * Friendly labels for PASSIVE READ scopes — derived at render time, no write
 * change. A scope not in this map is not a "known read" and falls through to the
 * generic scope/endpoint rendering.
 */
export const READ_SCOPE_LABELS: Record<string, string> = {
  'buzz:read:self': 'Read your Buzz balance/history',
  'user:read:self': 'Read your viewer profile',
  'models:read:self': 'Read a model',
  'media:read:owned': 'Read your media',
  'collections:read:self': 'Read your collections',
  'apps:storage:read': 'Read your app storage',
  'apps:storage:shared:read': 'Read shared app storage',
  'block:settings:read': 'Read your block settings',
};

/** Runtime guard for a `detail` value read back off the DB (typed `unknown`). */
export function isBlockActionDetail(value: unknown): value is BlockActionDetail {
  if (typeof value !== 'object' || value === null) return false;
  const action = (value as { action?: unknown }).action;
  return typeof action === 'string' && action.length > 0;
}

/**
 * Display names the view has resolved (via batch lookups) for a detail's
 * subject-ref ids. All optional — a null/absent name falls back to a safe
 * generic subject (never an empty "on ").
 */
export type BlockActionNames = {
  /** Resolved from `detail.toUserId`. */
  username?: string | null;
  /**
   * Resolved display name for `detail.entityType`/`detail.entityId` — the view
   * supplies it only for the types it can name (today: ModelVersion via the
   * model-version batch). Absent → a generic "on a <entityType>" is rendered.
   */
  subjectName?: string | null;
};

function formatBuzz(amount: number): string {
  return `${Math.abs(amount).toLocaleString('en-US')} Buzz`;
}

/** Human word for an entity type in the "on a <type>" generic subject. */
function friendlyEntityType(entityType: string): string {
  switch (entityType) {
    case 'ModelVersion':
      return 'model version';
    case 'Image':
      return 'image';
    case 'Collection':
      return 'collection';
    case 'Model':
      return 'model';
    case 'Article':
      return 'article';
    case 'User':
      return 'creator';
    default:
      return entityType.toLowerCase();
  }
}

/**
 * The " on <subject>" clause for a detail carrying an entity ref. Renders the
 * resolved name when the view supplied one, else a safe generic ("on a model
 * version") — NEVER an empty "on ". Absent entity ref → no clause. Throw-safe.
 */
function describeSubject(detail: BlockActionDetail, names: BlockActionNames): string {
  if (!detail.entityType || detail.entityId == null) return '';
  if (names.subjectName && names.subjectName.length > 0) return ` on ${names.subjectName}`;
  return ` on this ${friendlyEntityType(detail.entityType)}`;
}

/**
 * Compose a human-readable sentence for a structured action detail. PURE — the
 * view resolves ids → names (batched) and passes them in. Unknown / future
 * action codes render a safe generic line rather than throwing, so a row written
 * by a newer deploy still shows something sensible.
 */
export function describeBlockAction(
  detail: BlockActionDetail,
  names: BlockActionNames = {}
): string {
  switch (detail.action) {
    case 'tip': {
      const who =
        names.username && names.username.length > 0
          ? `@${names.username}`
          : detail.toUserId != null
          ? `user #${detail.toUserId}`
          : 'a creator';
      const amt = typeof detail.amount === 'number' ? ` ${formatBuzz(detail.amount)}` : '';
      return `Tipped${amt} to ${who}${describeSubject(detail, names)}`;
    }
    case 'workflow.submit': {
      const amt =
        typeof detail.amount === 'number' && detail.amount !== 0
          ? ` (spent ${formatBuzz(detail.amount)})`
          : '';
      const failed = detail.outcome === 'failed' ? ' — failed' : '';
      return `Generated an image${amt}${failed}`;
    }
    case 'settings.update':
      return 'Saved your block settings';
    case 'storage.set':
      return detail.key ? `Wrote app storage "${detail.key}"` : 'Wrote app storage';
    case 'storage.delete':
      return detail.key ? `Deleted app storage "${detail.key}"` : 'Deleted app storage';
    case 'storage.increment':
      return detail.key ? `Bumped shared counter "${detail.key}"` : 'Bumped a shared counter';
    // 🔴 The KEY IS DELIBERATELY NOT RENDERED for these six, unlike the three
    // `storage.*` cases above. A per-user storage key is a name the app's author
    // chose (`playcount:<id>`, `settings`) and reads as a label; a shared_kv key
    // is a SERVER-GENERATED ULID, so putting it in the sentence would add 26
    // characters of noise and no information. It is still STORED on the row —
    // that is what makes a reported/withdrawn row traceable from the audit table
    // — which is the design's "stores IDS, not display names" split.
    case 'shared.append':
      return 'Posted to shared app storage';
    case 'shared.update':
      return 'Edited your post in shared app storage';
    case 'shared.vote':
      return 'Up-voted a post in shared app storage';
    case 'shared.unvote':
      return 'Removed your up-vote in shared app storage';
    case 'shared.withdraw':
      return 'Withdrew your post from shared app storage';
    case 'shared.report':
      return 'Reported a post in shared app storage';
    case 'post.create': {
      // Named rather than generic: without a case here the Activity feed renders
      // "Performed an app action" for the single most consequential thing a block
      // can do to a viewer's account, which is the opposite of what an audit row
      // is for.
      const n = typeof detail.imageCount === 'number' ? detail.imageCount : null;
      const what = n == null ? 'a post' : `a post with ${n} image${n === 1 ? '' : 's'}`;
      const failed = detail.outcome === 'failed' ? ' — failed' : '';
      // `describeSubject` reads `entityType`/`entityId`, which for this action is
      // the POST. The gallery target is a separate field and is named separately
      // so the sentence cannot confuse "posted to your profile" with "attached to
      // a model gallery" — they have different consequences.
      const gallery = detail.modelVersionId != null ? ', attached to a model gallery' : '';
      return `Published ${what} to your profile${gallery}${failed}`;
    }
    default:
      // Unknown / forward-compat action code — safe generic line.
      return 'Performed an app action';
  }
}
