import { constants } from '~/server/common/constants';
import { BlocklistType } from '~/server/common/enums';
import { extModeration } from '~/server/integrations/moderation';
import { logToAxiom } from '~/server/logging/client';
import type { ExternalModerationSource } from '~/server/prom/external-moderation.metrics';
import { REDIS_SYS_KEYS, sysRedis, withSysReadDeadline } from '~/server/redis/client';
import { decodeRedisString } from '~/server/redis/buffer-decode';
import { stripBenignPhrases } from '~/server/services/blocklist.service';
import { applyPendingReviewMute } from '~/server/services/user-restriction.service';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { normalizeText } from '~/utils/normalize-text';
import {
  auditPromptEnriched,
  isBlankAuditInput,
  isOverLengthRefusal,
  isSoftBlock,
  type PromptTrigger,
  type PromptTriggerCategory,
} from '~/utils/metadata/audit';

// --- Blocked Prompt Store ---
// Single Redis list stores both count (list length) and prompt data.
// If key doesn't exist, seeds from ClickHouse. Uses a reset marker to
// distinguish "empty because reset" from "doesn't exist".

export interface BlockedPromptEntry {
  prompt: string;
  negativePrompt: string;
  source: string;
  category?: PromptTriggerCategory;
  matchedWord?: string;
  matchedRegex?: string;
  imageId: number | null;
  remixOfId: number | null;
  // Base/source media attached to the blocked job, surfaced in the moderator
  // restriction-review UI so a deepfake against a real photo can be told apart
  // from a transform of AI content.
  inputImages?: string[];
  inputVideo?: string;
  time: string;
}

// Window over which we count blocked-prompt attempts toward the auto-mute threshold.
// Doubles as the Redis TTL and as the ClickHouse seed window so that a cold start
// (key missing / sysRedis wipe) rebuilds the counter with the same horizon it would
// have had in steady state. Keeping these in lockstep prevents the previous behavior
// where many users effectively accumulated forever in Redis but only recovered the
// last 24h after a wipe.
const GREEN_SFW_REDIRECT =
  'Civitai.com is intended for SFW content only. For NSFW content generation, please visit civitai.red where you have more freedom to generate mature content.';

const BLOCKED_PROMPTS_WINDOW_DAYS = 30;
const BLOCKED_PROMPTS_TTL = 60 * 60 * 24 * BLOCKED_PROMPTS_WINDOW_DAYS;
const LEGACY_MISSING_NEGATIVE_PROMPT = '{error capturing negativePrompt}';

// Shown for a regex refusal that names neither a trigger nor a reason (see classifyPromptServer).
const UNSPECIFIED_REGEX_REFUSAL = 'Prompt failed the content audit';

// An over-length refusal is recorded with only this much of each prompt. The refusal exists
// because the input is unboundedly large, so storing it whole would hand that payload to the
// audit log — and from there to the blocked-prompt list, which is re-seeded from that log.
const OVER_LENGTH_RECORDED_CHARS = 2000;
const truncateForRecord = (text: string | undefined) =>
  text != null && text.length > OVER_LENGTH_RECORDED_CHARS
    ? `${text.slice(0, OVER_LENGTH_RECORDED_CHARS)}… [truncated from ${text.length} chars]`
    : text;

const RESET_MARKER = '__RESET__';

function getBlockedPromptsKey(userId: number) {
  return `${REDIS_SYS_KEYS.GENERATION.BLOCKED_PROMPTS}:${userId}` as const;
}

/** Seed the blocked prompts list from ClickHouse for the configured rolling window. */
async function seedBlockedPromptsFromClickHouse(userId: number): Promise<void> {
  const key = getBlockedPromptsKey(userId);
  const { clickhouse } = await import('~/server/clickhouse/client');

  if (!clickhouse) {
    // No ClickHouse available, set reset marker so we don't keep trying
    await sysRedis.lPush(key, RESET_MARKER);
    await sysRedis.expire(key, BLOCKED_PROMPTS_TTL);
    return;
  }

  const data = await clickhouse.$query<{
    prompt: string;
    negativePrompt: string;
    source: string;
    remixOfId: number | null;
    inputImages: string[];
    inputVideo: string | null;
    time: string;
  }>`
    SELECT prompt, negativePrompt, source, remixOfId, inputImages, inputVideo, time
    FROM prohibitedRequests
    WHERE time > subtractDays(now(), ${BLOCKED_PROMPTS_WINDOW_DAYS}) AND userId = ${userId}
    ORDER BY time ASC
  `;

  if (data.length === 0) {
    // No violations today, set reset marker
    await sysRedis.lPush(key, RESET_MARKER);
  } else {
    // Add all violations (oldest first, so newest ends up at head)
    for (const row of data) {
      const entry: BlockedPromptEntry = {
        prompt: row.prompt,
        negativePrompt: row.negativePrompt,
        source: row.source,
        category: undefined,
        matchedWord: undefined,
        matchedRegex: undefined,
        imageId: null,
        remixOfId: row.remixOfId ?? null,
        inputImages: row.inputImages?.length ? row.inputImages : undefined,
        inputVideo: row.inputVideo || undefined,
        time: row.time,
      };
      await sysRedis.rPush(key, JSON.stringify(entry));
    }
  }
  await sysRedis.expire(key, BLOCKED_PROMPTS_TTL);
}

/** Get blocked prompt count, seeding from ClickHouse if key doesn't exist */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function getBlockedPromptCount(userId: number): Promise<number> {
  const key = getBlockedPromptsKey(userId);
  const exists = await sysRedis.exists(key);

  if (!exists) {
    await seedBlockedPromptsFromClickHouse(userId);
  }

  const entries = (await sysRedis.lRange(key, 0, -1)).map((e) => decodeRedisString(e));
  return entries.filter((e) => e !== RESET_MARKER).length;
}

/** Add a blocked prompt and return the new count */
async function addBlockedPrompt(userId: number, entry: BlockedPromptEntry): Promise<number> {
  const key = getBlockedPromptsKey(userId);
  // SAFETY-SENSITIVE: this runs only AFTER a prompt is flagged (inside
  // auditPromptServer's catch), on the way to auto-mute accounting. A sysRedis
  // error MUST keep propagating so auditPromptServer fails CLOSED (the generation
  // request aborts) rather than silently proceeding — do NOT add a fail-open catch.
  // The deadline only BOUNDS a silent half-open (which would otherwise park each
  // awaited read ~11min): it rejects at ~2s, preserving the same fail-closed
  // direction. See STEP-6 report's promptAuditing note.
  const exists = await withSysReadDeadline(sysRedis.exists(key));

  if (!exists) {
    await seedBlockedPromptsFromClickHouse(userId);
  }

  // Push the new entry first so the list is never empty during cleanup —
  // an empty list would auto-delete the key in Redis and discard its TTL.
  await sysRedis.lPush(key, JSON.stringify(entry));

  // If the seeded list was just a reset marker, drop the marker now that we
  // have a real entry. Using lRem (not del) preserves the TTL set by the seed.
  const currentEntries = (await withSysReadDeadline(sysRedis.lRange(key, 0, -1))).map((e) =>
    decodeRedisString(e)
  );
  if (currentEntries.includes(RESET_MARKER)) {
    await sysRedis.lRem(key, 0, RESET_MARKER);
  }

  // Marker has been removed above, so lLen now equals the real violation count.
  return await withSysReadDeadline(sysRedis.lLen(key));
}

/** Get all blocked prompts (excludes reset marker) */
async function getBlockedPrompts(userId: number): Promise<BlockedPromptEntry[]> {
  const key = getBlockedPromptsKey(userId);
  // Park-bounding only. This read is on the auto-mute sub-path — called from
  // reportProhibitedRequest INSIDE its `try { … } catch (banError)` block, so a
  // throw here is caught there (auto-mute is skipped + logged as
  // `user-ban-creation-error`; the current prompt is still blocked upstream).
  // Deadline the read so a silent half-open rejects at ~2s instead of parking
  // ~11min; we add no fail-open catch of our own — the existing banError handler
  // already bounds the blast to "mute skipped this once."
  const entries = (await withSysReadDeadline(sysRedis.lRange(key, 0, -1))).map((e) =>
    decodeRedisString(e)
  );
  return entries
    .filter((e) => e !== RESET_MARKER)
    .map((entry) => {
      const parsed = JSON.parse(entry) as BlockedPromptEntry;
      // Lists seeded from ClickHouse before the tracker stopped writing this placeholder for an
      // absent negative prompt still carry it for up to BLOCKED_PROMPTS_TTL.
      if (parsed.negativePrompt === LEGACY_MISSING_NEGATIVE_PROMPT) parsed.negativePrompt = '';
      return parsed;
    });
}

/**
 * Reset a user's blocked prompts (e.g., when unmuting).
 * Sets to empty (reset marker) instead of deleting, so ClickHouse won't be queried again.
 */
export async function resetProhibitedRequestCount(userId: number) {
  const key = getBlockedPromptsKey(userId);
  await sysRedis.del(key);
  await sysRedis.lPush(key, RESET_MARKER);
  await sysRedis.expire(key, BLOCKED_PROMPTS_TTL);
}

/**
 * Clear blocked prompts after they've been stored in the DB (e.g., after muting).
 * Deletes the key entirely - different from reset which leaves a marker.
 */
async function clearBlockedPromptsAfterMute(userId: number) {
  const key = getBlockedPromptsKey(userId);
  await sysRedis.del(key);
}

export interface AuditPromptOptions {
  prompt: string;
  negativePrompt?: string;
  userId: number;
  isGreen: boolean; // true on the GREEN domain, which is civitai.com — not a separate host
  isModerator?: boolean;
  track?: any; // Tracker
  imageId?: number; // Source image ID when triggered during a remix
  remixOfId?: number; // The original image being remixed
  inputImages?: string[]; // Base/source image URLs attached to the job
  inputVideo?: string; // Source video URL (vid2vid)
  // Only honored when every trigger is soft — see `isSoftBlock`.
  acknowledgedSoftBlock?: boolean;
  // OBSERVABILITY ONLY. Selects the `source` label on the external-moderation duration histogram so
  // the request-path prompt gate can be told apart from background work; changes no behaviour, no
  // deadline and no verdict. Absent ⇒ `other`, so a caller that declares nothing can never inflate
  // the `generate` population. See `~/server/prom/external-moderation.metrics`.
  moderationSource?: ExternalModerationSource;
}

export type PromptClassificationOutcome = 'pass' | 'soft' | 'hard';
export type PromptClassificationSource = 'regex' | 'external';

export interface PromptClassification {
  /**
   * `soft`/`hard` is `isSoftBlock(triggers)` — the same predicate `auditPromptServer` branches
   * on, so a caller reading this verdict cannot disagree with the enforcing path about tier.
   */
  outcome: PromptClassificationOutcome;
  /** Which check produced the block. `null` exactly when `outcome` is `pass`. */
  source: PromptClassificationSource | null;
  triggers: PromptTrigger[];
  /**
   * The user-facing reasons, one per trigger, in trigger order — except a trigger-less regex
   * refusal (hard, `triggers: []`), which carries the regex layer's own reasons instead.
   */
  blockedFor: string[];
  /**
   * The external classifier's categories as it returned them, whenever it RAN — including when it
   * did not flag and the verdict is a held soft regex block or a pass. Evidence, not the verdict.
   * Empty when it never ran (a hard regex block skips it) or when it failed open.
   */
  categories: string[];
  /**
   * The external classifier's failure message when it threw. It fails OPEN — the verdict is then
   * computed as though it had not flagged — so this is the only trace that it did not actually
   * clear the text. Reporting it is the caller's job; this function records nothing.
   */
  externalError: { message: string } | null;
}

export interface ClassifyPromptOptions {
  prompt: string;
  negativePrompt?: string;
  /** Applies the green-only blocklist. See `auditPromptServer` for what GREEN means. */
  isGreen: boolean;
  moderationSource?: ExternalModerationSource;
}

/**
 * The DECISION half of `auditPromptServer`, with none of its consequences: no ClickHouse report,
 * no blocked-prompt counter, no auto-mute, no Axiom event, no throw on a verdict. It still READS
 * — the benign-phrase lists and the external classifier — because those are inputs to the
 * decision, not records of it.
 *
 * It exists so a caller can learn what the audit WOULD do without the audit doing it (shadow
 * moderation). `auditPromptServer` is a wrapper over this, so the two cannot drift.
 *
 * Ordering, which is the part that matters:
 * - a regex refusal (`success: false`) is ALWAYS a block — a trigger-less one is HARD. It is
 *   never left to the external classifier alone.
 * - a HARD regex block short-circuits: the external classifier is not called.
 * - a SOFT regex block does NOT short-circuit. External moderation runs first and, if it flags
 *   with at least one category, its block wins; otherwise the held soft block is the verdict.
 *   Short-circuiting here would let an overridable word appended to a prompt buy a click-through
 *   past the hosted classifier.
 * - an external flag with ZERO categories is not a block (unchanged from before this split).
 *
 * An infrastructure failure other than the external classifier's (e.g. the benign-phrase read)
 * propagates as a throw — exactly as it did inside `auditPromptServer`.
 */
export async function classifyPromptServer(
  options: ClassifyPromptOptions
): Promise<PromptClassification> {
  const { prompt, negativePrompt, isGreen, moderationSource } = options;

  // Mirrors `auditPromptServer`'s own early return: when the prompt AND the negative prompt are
  // both empty there is nothing to audit, so the honest answer to "what would the audit do" is
  // pass — with no reads at all. An empty prompt beside a non-empty negative prompt is audited.
  if (isBlankAuditInput(prompt, negativePrompt)) {
    return {
      outcome: 'pass',
      source: null,
      triggers: [],
      blockedFor: [],
      categories: [],
      externalError: null,
    };
  }

  const verdict = (
    source: PromptClassificationSource,
    triggers: PromptTrigger[],
    categories: string[],
    externalError: PromptClassification['externalError'],
    // Only for a trigger-less regex refusal, whose reasons cannot come from its triggers.
    blockedFor: string[] = triggers.map((t) => t.message)
  ): PromptClassification => ({
    // `isSoftBlock([])` is false, so a trigger-less verdict is hard.
    outcome: isSoftBlock(triggers) ? 'soft' : 'hard',
    source,
    triggers,
    blockedFor,
    categories,
    externalError,
  });

  // 🔴 The green blocklist (`blocked-words.json`) is the ONLY list in this audit that
  // varies by domain, and it is not profanity in the ordinary sense — "breasts" blocks
  // on .com and passes on .red. Everything else below runs identically everywhere.
  const checkProfanity = isGreen;

  // Moderator-managed benign phrases (proper nouns / technical terms that
  // coincidentally contain a detection token) are blanked before auditing, so the
  // generation gate and the post-generation scan audit agree on what's benign.
  // Only the audited copy is cleaned — the original prompt is what gets generated,
  // reported to ClickHouse, and stored on the blocked-prompt entry.
  //
  // 🔴 Strip the NORMALIZED copy. `auditPromptEnriched` folds accents before the
  // detector runs, so stripping raw text matches one alphabet while the detector
  // reads another and a whitelisted `emma stone` still blocks `émma stone`. The
  // scan paths in image-scan-pipeline.ts already normalize first.
  const [auditedPrompt, auditedNegativePrompt] = await Promise.all([
    stripBenignPhrases(normalizeText(prompt), BlocklistType.PromptBenignPhrase),
    stripBenignPhrases(normalizeText(negativePrompt), BlocklistType.NegativeBenignPhrase),
  ]);

  // Run regex-based audit (enriched to capture structured trigger data)
  const {
    triggers,
    success,
    blockedFor: regexBlockedFor,
  } = auditPromptEnriched(auditedPrompt ?? prompt, auditedNegativePrompt, checkProfanity);

  let softRegexTriggers: PromptTrigger[] | null = null;

  // 🔴 FAIL CLOSED: a regex refusal is a block even when it names no trigger. Gating the block
  // on `triggers.length > 0` handed a trigger-less refusal to the external classifier alone —
  // how over-length input once skipped the regex layer. With no trigger there is nothing that
  // could make it soft, so it is HARD. `blockedFor` falls back to the regex layer's own reasons
  // here (the one verdict where it is not one-per-trigger), so the user still sees why.
  if (!success && triggers.length === 0) {
    return verdict(
      'regex',
      [],
      [],
      null,
      regexBlockedFor.length > 0 ? regexBlockedFor : [UNSPECIFIED_REGEX_REFUSAL]
    );
  }

  if (!success) {
    // A hard block short-circuits. A soft one must NOT — returning here would
    // skip the external classifier below, so appending any overridable word
    // ("… pee") to a prompt would buy a click-through past it. Hold the block
    // and let external moderation run first; it can only escalate.
    if (!isSoftBlock(triggers)) return verdict('regex', triggers, [], null);
    softRegexTriggers = triggers;
  }

  // Run external moderation service. Fails OPEN: a classifier error is treated as "not flagged".
  // `error.message` is read exactly as the pre-split code read it, untyped, so a non-Error
  // rejection reports the same (possibly undefined) message it always did.
  //
  // The classifier is sent the prompt only — never the negative prompt. So when the prompt is empty
  // (the negative prompt alone brought the input here) there is no text to send and it is not
  // called: the regex layer above is the whole audit for that input. Keyed on the RAW prompt, so a
  // non-empty prompt reaches the classifier exactly as before, even if benign-phrase stripping
  // emptied the audited copy.
  let externalError: PromptClassification['externalError'] = null;
  const { flagged, categories } = !prompt?.trim()
    ? { flagged: false, categories: [] as string[] }
    : await extModeration
        .moderatePrompt(auditedPrompt ?? prompt, moderationSource)
        .catch((error) => {
          externalError = { message: error.message };
          return { flagged: false, categories: [] as string[] };
        });

  if (flagged) {
    const externalTriggers: PromptTrigger[] = categories.map((cat) => ({
      category: 'external' as PromptTriggerCategory,
      message: cat,
      matchedWord: cat,
    }));
    if (externalTriggers.length > 0) {
      return verdict('external', externalTriggers, categories, externalError);
    }
  }

  // External moderation cleared it; now honor the held soft block.
  if (softRegexTriggers) return verdict('regex', softRegexTriggers, categories, externalError);

  return {
    outcome: 'pass',
    source: null,
    triggers: [],
    blockedFor: [],
    categories,
    externalError,
  };
}

/**
 * Centralized prompt auditing function that handles both regex and external moderation checks.
 *
 * @param options - Audit options including prompt, userId, and isGreen flag
 * @throws {TRPCError} If the prompt is flagged for inappropriate content
 *
 * Behavior:
 * 🔴 GREEN IS `civitai.com` in our deploys — the colour names a domain config
 * (`SERVER_DOMAIN_GREEN`), not a `civitai.green` host.
 *
 * `isGreen` pulls both ways: it applies an ADDITIONAL blocklist on .com, and on a hard
 * block it redirects to .red INSTEAD of recording the block. So .com refuses more and
 * punishes less.
 * - Tracks blocked attempts and escalates warnings based on user's violation count
 */
export async function auditPromptServer(options: AuditPromptOptions): Promise<void> {
  const {
    prompt,
    negativePrompt,
    userId,
    isGreen,
    isModerator,
    track,
    imageId,
    remixOfId,
    inputImages,
    inputVideo,
    acknowledgedSoftBlock,
    moderationSource,
  } = options;

  // Skip auditing only when there is nothing to audit — the prompt AND the negative prompt both
  // empty. An empty prompt beside a non-empty negative prompt is still audited.
  if (isBlankAuditInput(prompt, negativePrompt)) {
    return;
  }

  try {
    // The decision lives in `classifyPromptServer`; everything below is its consequences.
    // A non-verdict throw from the classifier (an infrastructure failure) lands in the same
    // catch it always did.
    const verdict = await classifyPromptServer({
      prompt,
      negativePrompt,
      isGreen,
      moderationSource,
    });

    // The classifier fails open on an external-moderation error and leaves reporting it to us.
    if (verdict.externalError) {
      logToAxiom({
        name: 'external-moderation-error',
        type: 'error',
        message: verdict.externalError.message,
      });
    }

    if (verdict.outcome !== 'pass') {
      throw { blockedFor: verdict.blockedFor, triggers: verdict.triggers, type: verdict.source };
    }
  } catch (e) {
    const error = e as { blockedFor: string[]; triggers: PromptTrigger[]; type: string };

    const softBlock = isSoftBlock(error.triggers ?? []);

    if (softBlock) {
      // A soft block never counts toward the auto-mute, acknowledged or not.
      // Counting the warning would auto-mute exactly the users this exists to help
      // (`daughter` alone blocks 139 of them) while offering them a proceed button.
      await reportProhibitedRequest({
        prompt,
        negativePrompt,
        userId,
        isModerator,
        track,
        source: error.type === 'external' ? 'External' : 'Regex',
        count: 0,
        remixOfId,
        inputImages,
        inputVideo,
      });

      // ClickHouse `source` is Enum8('Regex','External') and cannot record the
      // override, so this is the only trail of it until a column migration lands.
      if (acknowledgedSoftBlock) {
        logToAxiom({
          name: 'prompt-soft-block-override',
          type: 'info',
          userId,
          details: {
            triggers: error.triggers.map((t) => ({
              category: t.category,
              matchedWord: t.matchedWord,
            })),
          },
        }).catch(() => null);
        return;
      }
    }

    // Build error message based on domain
    let message: string;

    if (softBlock) {
      // No escalating "sent for review" tail (not counted), and on green no
      // "go to civitai.red" redirect. Soft means we are NOT confident this is
      // mature — that uncertainty is the whole reason we offer a proceed button,
      // so sending them to the adult domain would contradict it and push users
      // there over a false positive.
      message = `Your prompt was flagged: ${error.blockedFor.join(', ')}`;
    } else if (isGreen) {
      // 🔴 `prohibitedRequests` and everything downstream of it (auto-mute,
      // `UserRestriction` reviews) hold NO .com traffic — green takes this branch and
      // never reaches the recording in the `else`. A false-positive rate computed from
      // that data is a rate for .red and .blue only.
      message = `Your prompt was flagged: ${error.blockedFor.join(', ')}.\n\n${GREEN_SFW_REDIRECT}`;
    } else if (isOverLengthRefusal(error.triggers ?? [])) {
      // A SIZE refusal, not content evidence: the regex layer refused the input unscanned. It
      // is recorded for audit like a soft block — count 0 and no blocked-prompt counter write,
      // so it cannot trigger the auto-mute here — and with each prompt truncated, so the
      // unbounded payload the refusal exists to stop is never stored whole. No escalating
      // warning tail either: that tail reports the counter, which this did not touch.
      // ⚠ Like a soft block's row, the audit row is NOT distinguishable once recorded: a cold
      // `seedBlockedPromptsFromClickHouse` rebuilds the counter from every row in the window.
      await reportProhibitedRequest({
        prompt: truncateForRecord(prompt) ?? '',
        negativePrompt: truncateForRecord(negativePrompt),
        userId,
        isModerator,
        track,
        source: 'Regex',
        count: 0,
        remixOfId,
        inputImages,
        inputVideo,
      });
      message = `Your prompt was flagged: ${error.blockedFor.join(', ')}`;
    } else {
      const source = error.type === 'external' ? 'External' : 'Regex';

      // Create blocked prompt entry
      const blockedEntry: BlockedPromptEntry = {
        prompt: prompt ?? '',
        negativePrompt: negativePrompt ?? '',
        source,
        category: error.triggers[0]?.category,
        matchedWord: error.triggers[0]?.matchedWord,
        imageId: imageId ?? null,
        remixOfId: remixOfId ?? null,
        inputImages,
        inputVideo,
        time: new Date().toISOString(),
      };

      // Add to blocked prompts store and get count
      const count = await addBlockedPrompt(userId, blockedEntry);

      // Report to ClickHouse for audit logging and handle auto-mute
      await reportProhibitedRequest({
        prompt,
        negativePrompt,
        userId,
        isModerator,
        track,
        source,
        count,
        remixOfId,
        inputImages,
        inputVideo,
      });

      // civitai.com/civitai.red - standard escalating warnings
      message = `Your prompt was flagged: ${error.blockedFor.join(', ')}`;

      if (count > constants.imageGeneration.requestBlocking.muted) {
        message += '. Your account has been muted.';
      } else if (count > constants.imageGeneration.requestBlocking.notified) {
        message +=
          '. Your account has been sent for review. If you continue to attempt blocked prompts, your generation permissions will be revoked.';
      } else if (count > constants.imageGeneration.requestBlocking.warned) {
        message +=
          '. If you continue to attempt blocked prompts, your account will be sent for review.';
      }
    }

    // Flag rides `cause`; trpc.ts's errorFormatter lifts it onto data.softBlock.
    throw throwBadRequestError(message, softBlock ? { softBlock: true } : undefined);
  }
}

/**
 * Report a prohibited request and potentially mute the user.
 * Tracks the request in ClickHouse (audit log) and auto-mutes based on the Redis count.
 */
async function reportProhibitedRequest(options: {
  prompt: string;
  negativePrompt?: string;
  userId: number;
  isModerator?: boolean;
  track?: any;
  source: string;
  count: number;
  remixOfId?: number;
  inputImages?: string[];
  inputVideo?: string;
}) {
  const {
    prompt,
    negativePrompt,
    userId,
    isModerator,
    track,
    source,
    count,
    remixOfId,
    inputImages,
    inputVideo,
  } = options;

  // Track the prohibited request in ClickHouse (audit log only)
  if (track) {
    try {
      await track.prohibitedRequest({
        prompt: prompt ?? '',
        negativePrompt: negativePrompt ?? '',
        source,
        remixOfId,
        inputImages,
        inputVideo,
      });
    } catch {
      // Continue with muting even if tracking fails
    }
  }

  // Skip muting for moderators
  if (isModerator) return;

  // Auto-mute when count exceeds the muted threshold
  if (count > constants.imageGeneration.requestBlocking.muted) {
    try {
      const allBlockedPrompts = await getBlockedPrompts(userId);

      await applyPendingReviewMute({
        userId,
        triggers: allBlockedPrompts,
        updateSource: 'promptAuditing:autoMute',
      });

      // Clear the blocked prompts from Redis now that they're stored in the DB
      await clearBlockedPromptsAfterMute(userId);
    } catch (banError) {
      logToAxiom({
        name: 'user-ban-creation-error',
        type: 'error',
        message: (banError as Error).message,
        details: { userId },
      });
    }

    if (track) {
      await track.userActivity({
        type: 'Muted',
        targetUserId: userId,
      });
    }
  }
}
