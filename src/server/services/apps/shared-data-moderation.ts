import { createHash } from 'node:crypto';

import { getProfanityFilter } from '~/libs/profanity-simple';
import { clickhouse } from '~/server/clickhouse/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import { findBlockedUserContent, stripBenignPhrases } from '~/server/services/blocklist.service';
import { BlocklistType } from '~/server/common/enums';
import { auditPromptEnriched, includesMinor, includesPoi } from '~/utils/metadata/audit';
import { normalizeText } from '~/utils/normalize-text';
import {
  collectSharedDataLeaves,
  stripFormatChars,
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
 * delete the telemetry at exactly the moment its rate is most worth watching. So the modes are
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

/** The order a write is rejected in when one leaf trips several checks — the title/body order. */
const CATEGORY_PRIORITY: SharedDataHitCategory[] = [
  'overflow',
  'minor',
  'poi',
  'link',
  'pattern',
  'audit_regex',
];

export interface SharedTextInput {
  /** The leaf as stored. */
  raw: string;
  path: string;
  kind: SharedDataLeafKind;
}

export interface SharedTextHit {
  category: SharedDataHitCategory;
  /** The matched term as the detector reported it. Never returned to the client. */
  matched: string;
  /** The leaf that tripped it, or `null` for an overflow (which is about the blob, not a leaf). */
  leaf: SharedTextInput | null;
}

export interface SharedTextScan {
  leafCount: number;
  /** A walk cap (`depth`/`leaves`/`chars`) or the full-audit budget (`audit_budget`). */
  overflow: SharedDataOverflow | 'audit_budget' | null;
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

/**
 * The green-domain regex audit over ONE leaf, the way `assertSharedTextSafe` audits title/body:
 * normalised, moderator-declared benign phrases blanked, profanity on (`isGreen: true`).
 *
 * Returns the matched term, `null` for a pass, or `AUDIT_BUDGET_EXCEEDED`.
 *
 * Any `success: false` is a hit, whatever the triggers say. An over-length leaf comes back
 * `success: false` with no trigger at all on the audit's current contract, and a check that only
 * looked at triggers would pass exactly the input the length rule exists to refuse.
 */
async function auditLeaf(
  text: string,
  budget: { remaining: number }
): Promise<string | null | typeof AUDIT_BUDGET_EXCEEDED> {
  if (!text.trim()) return null;
  const stripped = await stripBenignPhrases(normalizeText(text), BlocklistType.PromptBenignPhrase);
  const input = stripped || text;
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
  return first?.matchedWord ?? first?.category ?? blockedFor[0] ?? 'blocked';
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
  // Checks read the leaf with format characters removed; the record keeps the raw leaf.
  const texts = inputs.map((input) => stripFormatChars(input.raw));
  const hits: SharedTextHit[] = [];

  const blocklistHits = await findBlockedUserContent(texts, { exemptFromPatterns: isModerator });
  const budget = { remaining: SHARED_DATA_FULL_AUDIT_BUDGET };
  const audits: Array<string | null | typeof AUDIT_BUDGET_EXCEEDED> = [];
  // Sequential, so the budget is spent in leaf order and the outcome is deterministic.
  for (const text of texts) audits.push(await auditLeaf(text, budget));

  texts.forEach((text, index) => {
    const leaf = inputs[index];
    if (includesMinor(text)) hits.push({ category: 'minor', matched: 'minor', leaf });
    const poi = includesPoi(text);
    if (poi) hits.push({ category: 'poi', matched: typeof poi === 'string' ? poi : 'poi', leaf });
    for (const hit of blocklistHits) {
      if (hit.index !== index) continue;
      hits.push(
        hit.kind === 'link'
          ? { category: 'link', matched: hit.matched.join(','), leaf }
          : { category: 'pattern', matched: hit.matched, leaf }
      );
    }
    const audit = audits[index];
    if (audit === AUDIT_BUDGET_EXCEEDED) {
      hits.push({ category: 'overflow', matched: 'audit_budget', leaf });
    } else if (audit != null) {
      hits.push({ category: 'audit_regex', matched: audit, leaf });
    }
  });
  return hits;
}

function scanOf(leafCount: number, hits: SharedTextHit[]): SharedTextScan {
  const overflow = hits.some((h) => h.category === 'overflow') ? 'audit_budget' : null;
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
      hits: [{ category: 'overflow', matched: collected.overflow, leaf: null }],
    };
  }
  const hits = await classifySharedTexts(
    collected.leaves.map(({ raw, path, kind }) => ({ raw, path, kind })),
    opts
  );
  return scanOf(collected.leaves.length, hits);
}

/** A counter key is a single leaf. */
export async function scanCounterKey(
  key: string,
  opts: { isModerator?: boolean } = {}
): Promise<SharedTextScan> {
  const hits = await classifySharedTexts([{ raw: key, path: '', kind: 'key' }], opts);
  return scanOf(1, hits);
}

/** The hit a rejection is attributed to: the highest-priority category present. */
export function blockingHit(scan: SharedTextScan): SharedTextHit | null {
  for (const category of CATEGORY_PRIORITY) {
    const hit = scan.hits.find((h) => h.category === category);
    if (hit) return hit;
  }
  return null;
}

// ── Recording ─────────────────────────────────────────────────────────────────

/** ClickHouse table holding the per-leaf hit list (30-day TTL — see its migration). */
export const SHARED_DATA_HITS_TABLE = 'appBlocksSharedDataHits';
/** Leaf text is kept for review, cut to this many UTF-8 bytes. */
export const SHARED_DATA_HIT_TEXT_MAX_BYTES = 1024;
const MATCHED_MAX_CHARS = 200;

export type SharedDataSurface = 'append' | 'update' | 'counter';

export interface SharedDataScanContext {
  appBlockId: string;
  /** The row the text was written to; empty when a rejected create never got one. */
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

/**
 * `YYYY-MM-DD HH:MM:SS.mmm` (UTC) — the DateTime64(3) input form. A raw `toISOString()` is rejected
 * at parse time, and because the shared client inserts with `wait_for_async_insert: 0` that
 * rejection never reaches this process: the table would just stay empty. Same shape as the repo's
 * other DateTime64(3) writers.
 */
export function clickhouseDateTime64(d: Date): string {
  return d.toISOString().slice(0, 23).replace('T', ' ');
}

export function sharedDataHitRows(
  scan: SharedTextScan,
  ctx: SharedDataScanContext,
  now: Date = new Date()
) {
  const time = clickhouseDateTime64(now);
  return scan.hits.map((hit) => ({
    time,
    appBlockId: ctx.appBlockId,
    rowKey: ctx.rowKey,
    surface: ctx.surface,
    mode: ctx.mode,
    blocked: ctx.blocked ? 1 : 0,
    leafPath: hit.leaf?.path ?? '',
    leafKind: hit.leaf?.kind ?? '',
    category: hit.category,
    matched: hit.matched.slice(0, MATCHED_MAX_CHARS),
    leafLength: hit.leaf?.raw.length ?? 0,
    leafSha256: hit.leaf ? createHash('sha256').update(hit.leaf.raw, 'utf8').digest('hex') : '',
    leafText: hit.leaf ? truncateUtf8(hit.leaf.raw, SHARED_DATA_HIT_TEXT_MAX_BYTES) : '',
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
 * 🔴 THE LEAF TEXT GOES TO CLICKHOUSE ONLY. It is user content, and the hit table is the one sink
 * here with a retention this repo enforces (a TTL in its DDL). The Axiom event carries counts and
 * nothing a user wrote — not the text, not the matched term — and so does every failure log below.
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
        error: error instanceof Error ? error.message : String(error),
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
    run()
      .then((scan) => recordSharedDataScan(scan, { ...ctx, mode: 'shadow', blocked: false }))
      .catch((error) =>
        logToAxiom(
          {
            name: 'app-blocks-shared-data-moderation-shadow-failed',
            type: 'error',
            appBlockId: ctx.appBlockId,
            surface: ctx.surface,
            error: error instanceof Error ? error.message : String(error),
          },
          'block-audit'
        ).catch(() => undefined)
      );
  });
}
