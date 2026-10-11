import { createHash } from 'node:crypto';

import { getProfanityFilter } from '~/libs/profanity-simple';
import { clickhouse } from '~/server/clickhouse/client';
import { formatClickhouseDateTime64 } from '~/server/clickhouse/datetime';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import { findBlockedUserContent, stripBenignPhrases } from '~/server/services/blocklist.service';
import { BlocklistType } from '~/server/common/enums';
import {
  auditPromptEnriched,
  includesMinor,
  includesPoi,
  MAX_AUDIT_PROMPT_LENGTH,
} from '~/utils/metadata/audit';
import { normalizeText } from '~/utils/normalize-text';
import { stripInvisible } from '~/server/utils/confusable-fold';
import {
  collectSharedDataLeaves,
  type SharedDataLeafKind,
  type SharedDataOverflow,
} from '~/server/services/apps/shared-data-leaves';

/**
 * LOCAL moderation of the app-owned text in App Blocks shared storage: every string and object key
 * inside a row's `data` blob, and every counter key. `title`/`body` keep their own belt
 * (`assertSharedTextSafe`); this covers what that belt never reads.
 *
 * "Local" means every check here runs in-process over lists the platform already holds — the minor
 * and POI detectors, the green-domain prompt regex audit, and the two blocklists. No external or
 * LLM classifier is called.
 *
 * ## Two flags, three modes
 *
 * - `app-blocks-shared-data-moderation` (SHADOW): scan after the write commits, off the request
 *   path, and record what WOULD have been blocked. Never rejects, never files a report, never emits
 *   an abuse alert, never counts toward a mute.
 * - `app-blocks-shared-data-moderation-enforce` (ENFORCE): scan inline before the write, and reject
 *   a hit with the same consequences as a `title`/`body` hit.
 *
 * 🔴 ENFORCE IMPLIES SCAN. With enforce on and shadow off, the scan still runs (inline) and still
 * records its hits and its denominator — otherwise turning shadow off after the enforce flip would
 * delete the telemetry at exactly the moment its rate is most worth watching. An enforce-mode hit
 * row carries NO user text in ANY column, though (see `sharedDataHitRows` for the per-column
 * rule): hashes, platform-authored labels and metadata only. User text is recorded only by
 * shadow-mode scans. So the modes are
 * `off` (both off — no scan, no record, behaviour identical to before this existed), `shadow`
 * (shadow on, enforce off) and `enforce` (enforce on, shadow either way).
 *
 * ## Evaluation — per APP, not per user
 *
 * Both flags are evaluated with the app block id as the Flipt entity id and NO context. That is
 * what makes them ramp: a percentage rollout buckets on `hash(entityId + flagKey)`, so it selects a
 * sticky subset of APPS, and a segment built from `ENTITY_ID_COMPARISON` constraints can list
 * specific app block ids. A context-reading segment (`moderators`, `testers`, any identity or tier
 * cohort) matches NOTHING here and returns the flag's base value — deliberately: whether an app's
 * data is moderated must not depend on who happens to be writing to it.
 */

export type SharedDataModerationMode = 'off' | 'shadow' | 'enforce';

export async function resolveSharedDataModerationMode(
  appBlockId: string
): Promise<SharedDataModerationMode> {
  const [shadow, enforce] = await Promise.all([
    isFlipt(FLIPT_FEATURE_FLAGS.APP_BLOCKS_SHARED_DATA_MODERATION, appBlockId),
    isFlipt(FLIPT_FEATURE_FLAGS.APP_BLOCKS_SHARED_DATA_MODERATION_ENFORCE, appBlockId),
  ]);
  if (enforce) return 'enforce';
  if (shadow) return 'shadow';
  return 'off';
}

export type SharedDataHitCategory =
  | 'minor'
  | 'poi'
  | 'link'
  | 'pattern'
  | 'audit_regex'
  | 'overflow';

/**
 * The order a rejection is ATTRIBUTED in when several checks fire — which decides the Report row
 * and the alert. minor/POI come first, ahead even of an overflow: an overflow still rejects the
 * write, but if the same write also carried a legal signal, that signal must reach the legal-block
 * channel and the moderation queue rather than be filed as "too large to review".
 */
const CATEGORY_PRIORITY: SharedDataHitCategory[] = [
  'minor',
  'poi',
  'overflow',
  'link',
  'pattern',
  'audit_regex',
];

export interface SharedTextInput {
  /** The leaf as stored. */
  raw: string;
  path: string;
  /** `path` as parts — a number is an array index, a string a user-written key. */
  segments: ReadonlyArray<string | number>;
  kind: SharedDataLeafKind;
}

export interface SharedTextHit {
  category: SharedDataHitCategory;
  /**
   * The matched term as the detector reported it. Never returned to the client. For `link` (the
   * URL as written) and `audit_regex` (the word as the input carried it) this is a SUBSTRING OF THE
   * LEAF — user text.
   */
  matched: string;
  /**
   * What matched, in PLATFORM-AUTHORED terms only — never a substring of the leaf: the category
   * name (`minor`), the list word (`poi`), the blocklist entry (`pattern`), the audit trigger's
   * category (`audit_regex`, e.g. `profanity`), the cap (`overflow`), or `''` (`link`: the list
   * does not report which entry matched, only the user's URL). An enforce-mode record stores this in
   * place of `matched`.
   */
  label: string;
  /** The leaf that tripped it, or `null` for an overflow (which is about the blob, not a leaf). */
  leaf: SharedTextInput | null;
}

/** Overflows found while classifying leaves, as opposed to while walking the blob. */
type LeafOverflow = 'audit_budget' | 'leaf_length';

export interface SharedTextScan {
  leafCount: number;
  /**
   * A walk cap (`depth`/`leaves`/`chars`), the full-audit budget (`audit_budget`), or one leaf
   * past the audit's length ceiling (`leaf_length`).
   */
  overflow: SharedDataOverflow | LeafOverflow | null;
  hits: SharedTextHit[];
}

/**
 * How many leaves in one scan may take the FULL profanity audit (see `auditLeaf`). Each costs
 * ~2.2 ms, so this bounds one write's worst case at ~70 ms. A leaf the prefilter flags once the
 * budget is spent is NOT passed: it becomes an `overflow` (`audit_budget`) hit, the same rule as
 * every other cap — text that was not fully read does not get through by being past a cap.
 */
export const SHARED_DATA_FULL_AUDIT_BUDGET = 32;

/** `auditLeaf`'s answer for a leaf the prefilter flagged after the budget ran out. */
const AUDIT_BUDGET_EXCEEDED = Symbol('audit-budget-exceeded');
/** `auditLeaf`'s answer for a leaf longer than the audit will read at all. */
const LEAF_TOO_LONG = Symbol('leaf-too-long');
/** A hit: the matched word as the input carried it, and the trigger's platform category. */
type AuditLeafMatch = { matched: string; label: string };
type AuditLeafResult = AuditLeafMatch | null | typeof AUDIT_BUDGET_EXCEEDED | typeof LEAF_TOO_LONG;

/**
 * The green-domain regex audit over ONE leaf, the way `assertSharedTextSafe` audits title/body:
 * normalised, moderator-declared benign phrases blanked, profanity on (`isGreen: true`).
 *
 * Returns the match (term + trigger category), `null` for a pass, `AUDIT_BUDGET_EXCEEDED`, or
 * `LEAF_TOO_LONG`.
 *
 * A leaf longer than `MAX_AUDIT_PROMPT_LENGTH` is not audited at all — the audit refuses such
 * input outright rather than read part of it — and is answered `LEAF_TOO_LONG`, which the caller
 * reports as an OVERFLOW: unreviewable, so rejected in enforce, but not a content signal, so it
 * files no Report. (Title/body cannot reach this; their caps are far below the ceiling. A `data`
 * leaf can, up to the 64 KB value cap — and a benign app storing one long string must not feed the
 * moderation queue on every retry.) This is decided HERE, from the length, so it does not depend on
 * how the audit happens to report the case.
 *
 * Any other `success: false` is a hit whatever the triggers say — a check that only looked at
 * triggers would pass any refusal the audit reports without one.
 */
async function auditLeaf(text: string, budget: { remaining: number }): Promise<AuditLeafResult> {
  if (!text.trim()) return null;
  const stripped = await stripBenignPhrases(normalizeText(text), BlocklistType.PromptBenignPhrase);
  const input = stripped || text;
  if (input.length > MAX_AUDIT_PROMPT_LENGTH) return LEAF_TOO_LONG;
  // 🔴 COST, measured: `auditPromptEnriched(_, _, true)` builds a fresh profanity matcher on every
  // call, ~2.2 ms each — 1,000 leaves took 2.2 s against 12 ms with profanity off. So the profanity
  // step is asked for only when the CACHED matcher (same config: no moderator whitelist) already
  // finds profanity in the same normalised input. That prefilter reads a SUPERSET of what the audit
  // reads (the audit additionally blanks booru rating/score/source tags first), so it can only send
  // extra leaves down the full path, never fewer — and the verdict always comes from the audit
  // itself. `shared-data-moderation.test.ts` pins fast-path ≡ full-audit over a corpus.
  const mayBeProfane = getProfanityFilter().analyze(normalizeText(input)).isProfane;
  const fullAudit = mayBeProfane && budget.remaining > 0;
  if (fullAudit) budget.remaining -= 1;
  const { success, triggers, blockedFor } = auditPromptEnriched(input, undefined, fullAudit);
  if (success) return mayBeProfane && !fullAudit ? AUDIT_BUDGET_EXCEEDED : null;
  const first = triggers[0];
  return {
    matched: first?.matchedWord ?? first?.category ?? blockedFor[0] ?? 'blocked',
    // `blockedFor` is deliberately NOT a fallback here: for profanity it is the input's own words.
    label: first?.category ?? 'blocked',
  };
}

/**
 * Every local check over a set of texts. PURE in the sense that matters for shadow mode: it reads
 * the blocklists and the benign-phrase list, and does nothing else — no throw on a verdict, no
 * report, no alert, no mute accounting.
 *
 * The blocklist is called ONCE with the texts as separate array entries. Never joined: a pattern
 * spanning the seam between two independent leaves would match text nobody wrote.
 */
export async function classifySharedTexts(
  inputs: SharedTextInput[],
  { isModerator = false }: { isModerator?: boolean } = {}
): Promise<SharedTextHit[]> {
  if (!inputs.length) return [];
  // 🔴 Checks read the leaf with every invisible character removed — all of `\p{Cf}` plus the
  // invisibles that are not `Cf` (Hangul fillers, the combining grapheme joiner, variation
  // selectors). Such a character renders as nothing, so a word split by one reads as the word to a
  // viewer while a regex sees two tokens. `stripInvisible` is the platform's one definition, shared
  // with the blocklist's confusable fold. This is the ONLY place the strip happens; the record
  // keeps the raw leaf.
  const texts = inputs.map((input) => stripInvisible(input.raw));
  const hits: SharedTextHit[] = [];

  const blocklistHits = await findBlockedUserContent(texts, { exemptFromPatterns: isModerator });
  const budget = { remaining: SHARED_DATA_FULL_AUDIT_BUDGET };
  const audits: AuditLeafResult[] = [];
  // Sequential, so the budget is spent in leaf order and the outcome is deterministic.
  for (const text of texts) audits.push(await auditLeaf(text, budget));

  texts.forEach((text, index) => {
    const leaf = inputs[index];
    if (includesMinor(text))
      hits.push({ category: 'minor', matched: 'minor', label: 'minor', leaf });
    const poi = includesPoi(text);
    if (poi) {
      // `includesPoi` (no prompt-edit matching) returns the LIST word, never the input's spelling.
      const word = typeof poi === 'string' ? poi : 'poi';
      hits.push({ category: 'poi', matched: word, label: word, leaf });
    }
    for (const hit of blocklistHits) {
      if (hit.index !== index) continue;
      hits.push(
        hit.kind === 'link'
          ? // `matched` here is the user's URLs as written: user text.
            { category: 'link', matched: hit.matched.join(','), label: '', leaf }
          : // The blocklist ENTRY that matched (a substring rule) — platform-authored.
            { category: 'pattern', matched: hit.matched, label: hit.matched, leaf }
      );
    }
    const audit = audits[index];
    if (audit === AUDIT_BUDGET_EXCEEDED) {
      hits.push({ category: 'overflow', matched: 'audit_budget', label: 'audit_budget', leaf });
    } else if (audit === LEAF_TOO_LONG) {
      hits.push({ category: 'overflow', matched: 'leaf_length', label: 'leaf_length', leaf });
    } else if (audit != null) {
      hits.push({ category: 'audit_regex', matched: audit.matched, label: audit.label, leaf });
    }
  });
  return hits;
}

function scanOf(leafCount: number, hits: SharedTextHit[]): SharedTextScan {
  const first = hits.find((h) => h.category === 'overflow');
  const overflow = first ? (first.matched as LeafOverflow) : null;
  return { leafCount, overflow, hits };
}

/** Walk a stored `data` blob and classify every distinct leaf. */
export async function scanSharedData(
  data: unknown,
  opts: { isModerator?: boolean } = {}
): Promise<SharedTextScan> {
  const collected = collectSharedDataLeaves(data);
  if ('overflow' in collected) {
    return {
      leafCount: 0,
      overflow: collected.overflow,
      hits: [
        {
          category: 'overflow',
          matched: collected.overflow,
          label: collected.overflow,
          leaf: null,
        },
      ],
    };
  }
  const hits = await classifySharedTexts(
    collected.leaves.map(({ raw, path, segments, kind }) => ({ raw, path, segments, kind })),
    opts
  );
  return scanOf(collected.leaves.length, hits);
}

/** A counter key is a single leaf. */
export async function scanCounterKey(
  key: string,
  opts: { isModerator?: boolean } = {}
): Promise<SharedTextScan> {
  const hits = await classifySharedTexts([{ raw: key, path: '', segments: [], kind: 'key' }], opts);
  return scanOf(1, hits);
}

/**
 * The hit a rejection is attributed to: the highest-priority category present. A `pattern` hit
 * counts only when `enforcePatterns` — see `sharedTextBlockingHit` in the router for why.
 */
export function blockingHit(
  scan: SharedTextScan,
  { enforcePatterns = true }: { enforcePatterns?: boolean } = {}
): SharedTextHit | null {
  for (const category of CATEGORY_PRIORITY) {
    if (category === 'pattern' && !enforcePatterns) continue;
    const hit = scan.hits.find((h) => h.category === category);
    if (hit) return hit;
  }
  return null;
}

// ── Recording ─────────────────────────────────────────────────────────────────

/** ClickHouse table holding the per-leaf hit list (30-day TTL — see its migration). */
export const SHARED_DATA_HITS_TABLE = 'appBlocksSharedDataHits';
/** Leaf text (shadow-mode rows only) is kept for review, cut to this many UTF-8 bytes. */
export const SHARED_DATA_HIT_TEXT_MAX_BYTES = 1024;
/** The leaf path is cut too, because it is made of user-authored keys. */
export const SHARED_DATA_HIT_PATH_MAX_BYTES = 512;
/** Hex chars of sha256 standing in for one user-written key in an enforce-mode `leafPath`. */
export const SHARED_DATA_HIT_PATH_KEY_HASH_CHARS = 16;
const MATCHED_MAX_CHARS = 200;

export type SharedDataSurface = 'append' | 'update' | 'counter';

export interface SharedDataScanContext {
  appBlockId: string;
  /**
   * The row the text was written to (a counter's key for `counter`); empty when a rejected create
   * never got one. User text when it is a counter key — stored verbatim in shadow mode only.
   */
  rowKey: string;
  surface: SharedDataSurface;
  mode: Exclude<SharedDataModerationMode, 'off'>;
  /** True when this scan rejected the write. */
  blocked: boolean;
}

/** Cut to at most `maxBytes` of UTF-8 without splitting a code point. */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let bytes = 0;
  let out = '';
  for (const ch of text) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (bytes + size > maxBytes) break;
    bytes += size;
    out += ch;
  }
  return out;
}

const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * An enforce-mode `leafPath`: the same shape, with every user-written KEY replaced by `#` + the
 * first `SHARED_DATA_HIT_PATH_KEY_HASH_CHARS` hex of its sha256. Array indices are kept — they are
 * structure, not text. A key can never be confused with an index (`#` is not a digit), and a key
 * leaf's own last segment is the prefix of its `leafSha256`, so the two correlate.
 */
export function structuralLeafPath(segments: ReadonlyArray<string | number>): string {
  return segments
    .map((part) =>
      typeof part === 'number'
        ? String(part)
        : `#${sha256Hex(part).slice(0, SHARED_DATA_HIT_PATH_KEY_HASH_CHARS)}`
    )
    .join('/');
}

/**
 * One ClickHouse row per hit.
 *
 * 🔴 WHAT EACH COLUMN HOLDS, BY MODE. Shadow (the soak) keeps user text so a reviewer can judge the
 * hit rate before the enforce flip. ENFORCE STORES NO USER TEXT IN ANY COLUMN — so leaving enforce
 * on does not keep accumulating user content:
 *
 * - `rowKey` — shadow: the row / counter key as written. Enforce: `''`, because a counter key is
 *   user-chosen text, and so is an updated row's key when that row is a counter's anchor.
 * - `rowKeySha256` — sha256 of the key (`''` when there is none), in both modes, so an enforce row
 *   still joins to its row.
 * - `leafPath` — shadow: the JSON-pointer path, built from user-written keys. Enforce:
 *   `structuralLeafPath`, every key hashed, array indices kept.
 * - `matched` — shadow: the detector's term, which for `link` and `audit_regex` is a substring of
 *   the leaf. Enforce: `hit.label`, platform-authored only.
 * - `leafText` — shadow: the leaf, cut to 1 KB. Enforce: `''`.
 * - `leafSha256`, `leafLength`, `leafKind`, `category`, `appBlockId`, `surface`, `mode`,
 *   `blocked`, `time` — the same in both: a hash, a number, or a platform value.
 *
 * Every row expires with the table's TTL — at most 30 days after it was written, plus the TTL merge
 * lag (see the DDL) — so every stored text is gone at most that long after the soak ends.
 */
export function sharedDataHitRows(
  scan: SharedTextScan,
  ctx: SharedDataScanContext,
  now: Date = new Date()
) {
  const time = formatClickhouseDateTime64(now);
  const shadow = ctx.mode === 'shadow';
  const rowKeySha256 = ctx.rowKey ? sha256Hex(ctx.rowKey) : '';
  return scan.hits.map((hit) => ({
    time,
    appBlockId: ctx.appBlockId,
    rowKey: shadow ? ctx.rowKey : '',
    rowKeySha256,
    surface: ctx.surface,
    mode: ctx.mode,
    blocked: ctx.blocked ? 1 : 0,
    // Truncated: even hashed, a path is one segment per nesting level, up to the depth cap.
    leafPath: truncateUtf8(
      hit.leaf ? (shadow ? hit.leaf.path : structuralLeafPath(hit.leaf.segments)) : '',
      SHARED_DATA_HIT_PATH_MAX_BYTES
    ),
    leafKind: hit.leaf?.kind ?? '',
    category: hit.category,
    matched: (shadow ? hit.matched : hit.label).slice(0, MATCHED_MAX_CHARS),
    leafLength: hit.leaf?.raw.length ?? 0,
    leafSha256: hit.leaf ? sha256Hex(hit.leaf.raw) : '',
    // The empty string is the column default, not a placeholder for later.
    leafText: shadow && hit.leaf ? truncateUtf8(hit.leaf.raw, SHARED_DATA_HIT_TEXT_MAX_BYTES) : '',
  }));
}

function categoryCounts(scan: SharedTextScan): Record<SharedDataHitCategory, number> {
  const counts: Record<SharedDataHitCategory, number> = {
    minor: 0,
    poi: 0,
    link: 0,
    pattern: 0,
    audit_regex: 0,
    overflow: 0,
  };
  for (const hit of scan.hits) counts[hit.category] += 1;
  return counts;
}

/**
 * Record one scan: a count-only Axiom event (the denominator — one per scanned write, hits or not)
 * and, when there are hits, one ClickHouse row per hit.
 *
 * 🔴 USER TEXT GOES TO CLICKHOUSE ONLY, AND ONLY FROM A SHADOW-MODE SCAN (enforce rows carry none
 * in any column — see `sharedDataHitRows`). It is user content, and the hit table is the one sink
 * here with a retention this repo enforces (a TTL in its DDL). The Axiom event carries ids, counts
 * and platform values — not the text, not a key, not the matched term — and so does every failure
 * log below.
 * With no ClickHouse client (dev, build) the rows are dropped, never re-routed to a log.
 *
 * Never throws: a recording failure must not change the outcome of a write.
 */
export async function recordSharedDataScan(
  scan: SharedTextScan,
  ctx: SharedDataScanContext
): Promise<void> {
  const counts = categoryCounts(scan);
  await logToAxiom(
    {
      name: 'app-blocks-shared-data-moderation-scan',
      type: 'info',
      appBlockId: ctx.appBlockId,
      surface: ctx.surface,
      mode: ctx.mode,
      blocked: ctx.blocked,
      leafCount: scan.leafCount,
      // `depth` | `leaves` | `chars` | `audit_budget`, or empty. The per-category counts below
      // include `overflow` as a NUMBER, hence the different name.
      overflowKind: scan.overflow ?? '',
      hitCount: scan.hits.length,
      ...counts,
    },
    'block-audit'
  ).catch(() => undefined);

  if (!scan.hits.length || !clickhouse) return;
  try {
    await clickhouse.insert({
      table: SHARED_DATA_HITS_TABLE,
      values: sharedDataHitRows(scan, ctx),
      format: 'JSONEachRow',
    });
  } catch (error) {
    await logToAxiom(
      {
        name: 'app-blocks-shared-data-moderation-record-failed',
        type: 'error',
        appBlockId: ctx.appBlockId,
        hitCount: scan.hits.length,
        // The error NAME only: a ClickHouse parse error can quote the row it rejected, and the
        // row carries the leaf text this function promises never to log.
        error: error instanceof Error ? error.name : typeof error,
      },
      'block-audit'
    ).catch(() => undefined);
  }
}

/**
 * SHADOW: scan and record, off the request path. Returns immediately; nothing is awaited by the
 * caller and nothing it does can reach the caller.
 *
 * `setImmediate`, not a bare un-awaited call: an async function runs synchronously up to its first
 * `await`, so `void scan()` would walk the blob and run the first detectors on the request's own
 * tick, before the response is written. Deferring to the check phase moves ALL of it after.
 */
export function scheduleSharedDataShadow(
  run: () => Promise<SharedTextScan>,
  ctx: Omit<SharedDataScanContext, 'mode' | 'blocked'>
): void {
  setImmediate(() => {
    // `Promise.resolve().then(run)`, not `run()`: a SYNCHRONOUS throw inside `run` (before its
    // first await) would otherwise escape this callback as an uncaught exception instead of
    // reaching the catch below.
    Promise.resolve()
      .then(run)
      .then((scan) => recordSharedDataScan(scan, { ...ctx, mode: 'shadow', blocked: false }))
      .catch((error) =>
        logToAxiom(
          {
            name: 'app-blocks-shared-data-moderation-shadow-failed',
            type: 'error',
            appBlockId: ctx.appBlockId,
            surface: ctx.surface,
            // Name only: the scan parses and reads user text, and a message can quote it.
            error: error instanceof Error ? error.name : typeof error,
          },
          'block-audit'
        ).catch(() => undefined)
      );
  });
}
