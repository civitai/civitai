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
  | 'storage.increment';

export type BlockActionDetail = {
  /** Stable action code (see BlockActionCode). Free-form on the wire for fwd-compat. */
  action: string;
  /** Buzz delta for money actions — NEGATIVE for a spend, positive for a credit. */
  amount?: number;
  /** Subject refs — resolved to display names by the view's batch lookups. */
  toUserId?: number;
  modelVersionId?: number;
  entityId?: number;
  entityType?: string;
  /** Storage key (already scoped to the user's own namespace). */
  key?: string;
  /** Terminal outcome of the action. */
  outcome?: 'ok' | 'failed';
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
 * subject-ref ids. All optional — a null/absent name falls back to the raw id.
 */
export type BlockActionNames = {
  /** Resolved from `detail.toUserId`. */
  username?: string | null;
  /** Resolved from `detail.modelVersionId` (or an entity ref). */
  subjectName?: string | null;
};

function formatBuzz(amount: number): string {
  return `${Math.abs(amount).toLocaleString('en-US')} Buzz`;
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
  const subject =
    names.subjectName && names.subjectName.length > 0
      ? ` · ${names.subjectName}`
      : detail.modelVersionId
      ? ` · model version #${detail.modelVersionId}`
      : '';

  switch (detail.action) {
    case 'tip': {
      const who =
        names.username && names.username.length > 0
          ? `@${names.username}`
          : detail.toUserId != null
          ? `user #${detail.toUserId}`
          : 'a creator';
      const amt = typeof detail.amount === 'number' ? ` ${formatBuzz(detail.amount)}` : '';
      return `Tipped${amt} to ${who}${subject}`;
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
    default:
      // Unknown / forward-compat action code — safe generic line.
      return 'Performed an app action';
  }
}
