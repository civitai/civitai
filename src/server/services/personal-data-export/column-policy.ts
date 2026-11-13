/**
 * What a personal-data export may read and how each value is written. Applied in code, never left
 * to a reviewer: a credential column is not SELECTed at all, so it cannot reach an archive by a
 * later mistake in the writer.
 */

/** Per-table credential columns (Prisma field names). Never read. */
export const CREDENTIAL_COLUMNS: Record<string, readonly string[]> = {
  Account: ['refresh_token', 'access_token', 'id_token', 'session_state', 'token_type'],
  Session: ['sessionToken'],
  AdToken: ['token'],
  ApiKey: ['key'],
  AccessToken: ['tokenHash'],
  OauthClient: ['secret'],
  PushSubscription: ['p256dh', 'auth', 'endpoint'],
  ScanLabelClaim: ['token'],
  ScanLabelVote: ['claimToken'],
  Webhook: ['url'],
};

/** Any column whose name looks like a credential, on any table. Never read. */
export const CREDENTIAL_NAME_RE =
  /(token|secret|password|passwd|private_?key|mnemonic|seed_?phrase|api_?key|signature|^key$|^auth$)/i;

/**
 * Detection internals: classifier output, scan state, perceptual hashes. Never read, on any table.
 * A restriction's `triggers` is reduced separately (see `reduceTriggers`).
 */
export const CLASSIFIER_COLUMNS: Record<string, readonly string[]> = {
  Image: [
    'analysis',
    'scanJobs',
    'pHash',
    'hash',
    'needsReview',
    'nsfwLevelLocked',
    'minor',
    'poi',
    'acceptableMinor',
    'scanRequestedAt',
  ],
  WildcardSet: ['auditRuleVersion', 'invalidationReason'],
  ModelFile: ['pickleScanMessage', 'virusScanMessage'],
};

/**
 * Text columns written by automated checks, on any table: never written to the archive. The
 * Postgres counterpart of the ClickHouse `CH_DENY_RE`.
 */
export const DETECTION_TEXT_RE = /(blockedFor|scanMessage|audit|verdict|detect|classif)/i;

/**
 * Read for a row rule (see `transformRow`) but never written: `Image.blockedFor` decides whether an
 * image is listed as removed, and its text can carry an automated check's output.
 */
export const RULE_ONLY_COLUMNS: Record<string, readonly string[]> = {
  Image: ['blockedFor'],
};
export const CLASSIFIER_NAME_RE =
  /(scanJobs|^ai[A-Z]\w*|xguard|clavata|classifier|^pHash$|matchedTerms?|matchedRegex|^scores?$|ByScan$|TextHash$)/;

/**
 * ClickHouse tables read by an explicit column list instead of `SELECT *`: only these columns are
 * selected or written, so a column added to the table later does not reach an archive. Approved by
 * Legal; `orchestration.jobs` leaves out the worker, the issuer and remix ids.
 */
export const CH_COLUMN_ALLOWED: Record<string, readonly string[]> = {
  'orchestration.jobs': [
    'jobId',
    'externalId',
    'workflowStepCost',
    'userId',
    'jobType',
    'createdAt',
    'completedAt',
    'provider',
    'cost',
    'creatorsTip',
    'resourcesUsed',
    'serviceUpgradeFee',
    'claimDuration',
    'gpuDuration',
    'blobsCount',
    'queuedAt',
  ],
};

/** Other people's identities on a row that is otherwise the user's. Never read. */
export const OTHER_PEOPLE_COLUMNS: Record<string, readonly string[]> = {
  // Who else reported the same content.
  Report: ['alsoReportedBy'],
};

/**
 * Text written by staff about the user. Never in the archive: exported, like `internalNotes`, only
 * into the separate notes file, with staff names and ids redacted.
 */
export const NOTE_COLUMNS: Record<string, readonly string[]> = {
  Feedback: ['triageNote'],
  ArticleRatingReview: ['modComment'],
  UserRole: ['note'],
  UserMembershipOverride: ['note'],
  AppBlockPublishRequest: ['approvalNotes'],
  AppListingPublishRequest: ['approvalNotes'],
  CreatorScoreGrant: ['reason', 'revokeReason'],
  UserRestriction: ['resolvedReason'],
  Appeal: ['resolvedReason'],
  UserStrike: ['voidReason'],
  CashWithdrawal: ['note'],
  BlockBuzzAttribution: ['holdReason'],
  PlacementSuspension: ['reason'],
  ServiceOffering: ['removedReason'],
  Crucible: ['takedownReason'],
  AppListingModerationEvent: ['reason'],
};
export const NOTE_COLUMN = 'internalNotes';

/**
 * JSON columns are withheld unless listed here: a JSON value can carry anything (classifier output,
 * staff ids, internal ban text all live in `meta` columns), and a column-name rule cannot see inside
 * it. A listed column is still scrubbed key by key (`scrubJson`).
 */
export const JSON_ALLOWED: Record<string, readonly string[]> = {
  Image: ['meta'],
  GenerationPreset: ['values'],
  PostPreset: ['data'],
  UserProfile: ['privacySettings', 'profileSectionsSettings', 'showcaseItems'],
  Bounty: ['details'],
  Model3D: ['generationParams'],
  Report: ['details'],
  BuildGuide: ['components', 'capabilities'],
  Collection: ['metadata'],
  WildcardSet: ['metadata'],
  BlockUserSettings: ['settings'],
  // Reduced by the `restriction-triggers` rule, never written whole.
  UserRestriction: ['triggers'],
};

/** Keys dropped at any depth of an allowed JSON column. */
export const JSON_KEY_DENY_RE =
  /([Tt]oken|[Ss]ecret|[Pp]assword|[Ss]ignature|[Ss]core|[Tt]hreshold|[Mm]oderat|[Vv]erdict|[Ii]nternal|[Ss]can|^labels?$|^matche[sd]|Matches$|^rules?$|ruleIds?$|^flags?$|flagged|^minor|Minor|^poi$|^poi[A-Z_]|Poi$|reviewedBy|reviewer|phash|textHash|hashMatch|By$|ById$)/;

/** What a staff member's id or name is written as. */
export const STAFF_PLACEHOLDER = '[staff]';

/**
 * Integer columns naming who handled, reviewed, removed or wrote a record: `*By`, `*ById`,
 * `*ByUserId`, plus a few others. Their value is written as `[staff]` unless it is the user themself.
 * A registry `subject` or `others` role overrides this.
 */
export const STAFF_NAME_RE = /(By|ById|ByUserId)$|^(moderatorId|actorId)$/;

export type ColumnDecision =
  | 'read'
  | 'credential'
  | 'classifier'
  | 'others'
  | 'note'
  | 'withheld'
  | 'rule-only';

/** The decision for one column of one table. The first rule that matches wins. */
export function columnDecision(table: string, column: string, type?: string): ColumnDecision {
  if (CREDENTIAL_COLUMNS[table]?.includes(column) || CREDENTIAL_NAME_RE.test(column))
    return 'credential';
  if (CLASSIFIER_COLUMNS[table]?.includes(column) || CLASSIFIER_NAME_RE.test(column))
    return 'classifier';
  if (RULE_ONLY_COLUMNS[table]?.includes(column)) return 'rule-only';
  if (type === 'String' && DETECTION_TEXT_RE.test(column)) return 'classifier';
  if (OTHER_PEOPLE_COLUMNS[table]?.includes(column)) return 'others';
  if (column === NOTE_COLUMN || NOTE_COLUMNS[table]?.includes(column)) return 'note';
  if (type === 'Json' && !JSON_ALLOWED[table]?.includes(column)) return 'withheld';
  return 'read';
}

/** An allowed JSON value with every denied key removed, at any depth. */
export function scrubJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubJson);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>))
    if (!JSON_KEY_DENY_RE.test(k)) out[k] = scrubJson(v);
  return out;
}

/**
 * A staff-handled column's value as written: kept when it is the user themself, `[staff]` for anyone
 * else, empty when unset.
 */
export function redactStaff(value: unknown, subjectId: number): unknown {
  if (value === null || value === undefined) return value;
  return Number(value) === subjectId ? value : STAFF_PLACEHOLDER;
}

const TRIGGER_KEYS = new Set([
  'type',
  'category',
  'prompt',
  'negativePrompt',
  'time',
  'date',
  'createdAt',
]);

/**
 * A restriction's triggers reduced to a category, the user's own prompt and a time. Scores, matched
 * terms, rule names and anything else a trigger carries are dropped, whatever its shape.
 */
export function reduceTriggers(triggers: unknown): unknown {
  if (!Array.isArray(triggers)) return [];
  return triggers.map((t) => {
    if (!t || typeof t !== 'object') return {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(t as Record<string, unknown>))
      if (TRIGGER_KEYS.has(k) && (typeof v === 'string' || typeof v === 'number')) out[k] = v;
    return out;
  });
}

/** Moderator names and ids in a note's text, replaced with `[staff]`. */
export function redactNoteText(
  text: string,
  staff: { usernames: readonly string[]; ids: readonly number[] }
): string {
  let out = text;
  const names = [...staff.usernames]
    .filter((n) => n.length >= 2)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  if (names.length)
    out = out.replace(
      new RegExp(String.raw`(^|[^\w])@?(` + names.join('|') + String.raw`)(?!\w)`, 'gi'),
      (_m, pre: string) => `${pre}${STAFF_PLACEHOLDER}`
    );
  if (staff.ids.length) {
    const ids = new Set(staff.ids.map(String));
    out = out.replace(/(?<![\w#])\d{1,10}(?!\w)/g, (n) => (ids.has(n) ? STAFF_PLACEHOLDER : n));
  }
  return out;
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
