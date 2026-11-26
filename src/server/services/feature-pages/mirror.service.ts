import type { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import {
  clearFpRestricted,
  countFpOverduePushes,
  countFpOverdueRestrictions,
  countFpStuckRows,
  countFpSubjectWaits,
  type FpMirrorFactsRow,
  type FpPushRecord,
  type FpReconcileAction,
  fpMirrorTableExists,
  hasOpenPersonFpReport,
  leaseFpMirrorRow,
  leaseFpMirrorRows,
  markFpAuthorErased,
  markFpMirrorDue,
  markFpPostAttempted,
  markFpReconciled,
  markFpRemoveWanted,
  markFpRunbookRemoval,
  readFpMirrorByUrns,
  readFpMirrorFacts,
  readFpScanVerdict,
  readFpMirrorFactsPage,
  readFpRunbookCounts,
  readFpScanCandidates,
  recordFpPush,
  recordFpScanAttempt,
  releaseFpLeases,
} from '@civitai/db-queries/feature-page-comments';
import { constants } from '~/server/common/constants';
import { dbKV } from '~/server/db/db-helpers';
import { dbWrite } from '~/server/db/client';
import { kyselyWrite } from '~/server/db/kyselyDb';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_KEYS } from '~/server/redis/client';
import {
  afterCommentsV3Deleted,
  deleteCommentsV3,
} from '~/server/services/commentv3/moderation.service';
import { commentV3CsamHold, hasOpenCommentReport } from '~/server/services/commentv3/review-hold';
import { prismaRunner, setCommentFlags } from '~/server/services/commentv3/write.service';
import {
  callSigner,
  forgetFeaturePageViewerHandle,
  isRouteMissing,
  type SignerReply,
  SignerUnavailableError,
  signerErrorCode,
} from '~/server/services/feature-pages.service';
import {
  type FpCommentState,
  fpCommentState,
  fpPostDigest,
  fpWantDigest,
} from '~/server/services/feature-pages/comment-state';
import { fpHtmlToText } from '~/server/services/feature-pages/comment-text';
import {
  commentBySourceSchema,
  commentPostReplySchema,
  commentsPageSchema,
  PLATFORM_AUTHOR_ERASE_PATH,
  PLATFORM_COMMENT_BY_SOURCE_PATH,
  PLATFORM_COMMENT_PATH,
  PLATFORM_COMMENTS_PAGE_LIMIT,
  PLATFORM_COMMENTS_READ_PATH,
  PLATFORM_FEATURE_PAGES_APP,
  PLATFORM_MOD_VERDICT_PATH,
  PLATFORM_SITE_VERDICT_PATH,
  PLATFORM_STALE_DIGEST,
  PlatformRefusal,
  type PlatformCommentItem,
} from '~/server/services/feature-pages/platform-wire';
import { maskProfanityInChat } from '~/server/services/profanity-mask.service';
import { queueScamScan } from '~/server/services/text-scan/scam-scan-queue';
import { lockCsamHold } from '~/server/services/text-scan/actions/csam-hold';
import { getTextScanMode } from '~/server/services/text-scan/mode';
import {
  FEATURE_PAGES_FEATURE_URN_PREFIX,
  FEATURE_PAGES_TEXT_MAX_LENGTH,
} from '~/shared/constants/feature-pages.constants';
import { takeClusterWindowCount } from '~/server/utils/cluster-window-count';
import { sleep } from '~/utils/errorHandling';
import { currentScanContentHashes } from '~/server/services/text-scan/submit';

export const FP_MAX_PUSH_ATTEMPTS = 20;
const BACKOFF_MINUTES = [1, 5, 15, 60];
const LEASE_BATCH = 100;
const RUN_BUDGET_MS = 45_000;
const FACTS_PAGE = 1_000;
const FP_SCAN_GRACE_MINUTES = 5;
const FP_MAX_SCAN_ATTEMPTS = 5;
const FP_ALERT_MINUTES = 15;
const SWEEP_LIMIT = 2_000;
const SWEEP_CURSOR_KEY = 'feature-pages-sweep-scan-cursor';
/** Seconds a new comment waits for the cron, so the inline push and the cron never post it twice. */
export const FP_INLINE_GRACE_SECONDS = 60;
const SCAN_INACTIVE_WAIT_MINUTES = 5;
const SCAN_PENDING_WAIT_MINUTES = 1;
const STANDING_WAIT_MINUTES = 15;
const PARENT_WAIT_MINUTES = 5;
const UNRESOLVED_WAIT_MINUTES = 60;
const LEASE_DRAIN_MS = 150_000;
const SUBJECT_WAIT_ALERT_MINUTES = 24 * 60;

const log = (type: 'info' | 'error' | 'warning', message: string, payload: MixedObject) =>
  logToAxiom({ name: 'feature-pages-mirror', type, message, payload });

async function markAuthorErased(userId: number) {
  await markFpAuthorErased(kyselyWrite, userId);
  await forgetFeaturePageViewerHandle(userId);
}

const isFpMirrorOn = () => isFlipt(FLIPT_FEATURE_FLAGS.FEATURE_PAGES_MIRROR);

type Evaluated = { row: FpMirrorFactsRow; state: FpCommentState; postDigest: string; want: string };

function evaluate(row: FpMirrorFactsRow): Evaluated {
  const state = fpCommentState({
    goneCause: row.goneCause,
    pushedState: row.pushedState,
    comment: row.commentExists
      ? { hidden: !!row.hidden, tosViolation: !!row.tosViolation, deletedAt: row.deletedAt }
      : null,
    author: row.authorExists ? { deletedAt: row.authorDeletedAt } : null,
    csamHeld: row.csamHeld,
    removeWanted: !!row.removeWantedAt,
  });
  const postDigest = fpPostDigest(state, {
    authorName: row.username ?? '',
    content: row.content ?? '',
    version: row.version,
  });
  return { row, state, postDigest, want: fpWantDigest(state, postDigest) };
}

// Only a shown comment's text is sent, so only its digest can be behind.
const isPushed = ({ row, state, postDigest }: Evaluated) =>
  row.pushedState === state && (state !== 'visible' || row.pushedDigest === postDigest);

/**
 * The dirty pass: marks every row whose platform state or post changed since its last push, once
 * per change; a row already scheduled for the same change keeps its backoff. No hook is needed in
 * the paths that cause changes. Runs while the mirror is braked too, so the alert clock starts.
 */
export async function markChangedFpRows() {
  let after = 0;
  let marked = 0;
  for (;;) {
    const page = await readFpMirrorFactsPage(kyselyWrite, { after, limit: FACTS_PAGE });
    if (!page.length) break;
    after = page[page.length - 1].commentId;
    const evaluated = page.map(evaluate);
    // Before the marks: a mark moves updatedAt, so this clears only what nothing has changed since.
    await clearFpRestricted(
      kyselyWrite,
      evaluated
        .filter((e) => e.state === 'visible' && e.row.restrictedAt)
        .map((e) => ({ commentId: e.row.commentId, readAt: e.row.mirrorUpdatedAt }))
    );
    const due = evaluated
      .filter((e) => !isPushed(e) && e.row.pendingDigest !== e.want)
      .map((e) => ({
        commentId: e.row.commentId,
        pendingDigest: e.want,
        restrict: e.state !== 'visible',
      }));
    await markFpMirrorDue(kyselyWrite, due);
    marked += due.length;
    if (page.length < FACTS_PAGE) break;
  }
  return marked;
}

/** At the cap a push that may give up does; any other keeps going, hourly. */
const backoff = (attempts: number, givesUp: boolean): Date | null => {
  if (attempts >= FP_MAX_PUSH_ATTEMPTS) return givesUp ? null : new Date(Date.now() + 60 * 60_000);
  const minutes = BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length) - 1] ?? 60;
  return new Date(Date.now() + minutes * 60_000);
};

type StepOutcome =
  | { kind: 'ok'; body: unknown }
  | { kind: 'refused' }
  | { kind: 'removed' }
  | { kind: 'erased' }
  | { kind: 'stale'; digest: string | null }
  | { kind: 'retry'; status: number | 'unreachable' };

async function send(path: string, body: Record<string, unknown>): Promise<StepOutcome> {
  let reply: SignerReply;
  try {
    reply = await callSigner(path, { method: 'POST', body });
  } catch (e) {
    if (e instanceof SignerUnavailableError) return { kind: 'retry', status: 'unreachable' };
    throw e;
  }
  if (reply.status >= 200 && reply.status < 300) return { kind: 'ok', body: reply.body };
  const code = signerErrorCode(reply);
  if (isRouteMissing(reply)) {
    log('error', 'platform route missing', { path, status: reply.status });
    return { kind: 'retry', status: reply.status };
  }
  if (reply.status === 404 && code === PlatformRefusal.UnknownSubject) return { kind: 'refused' };
  if (reply.status === 409 && code === PlatformRefusal.Removed) return { kind: 'removed' };
  if (reply.status === 409 && code === PlatformRefusal.Erased) return { kind: 'erased' };
  if (reply.status === 409 && code === PLATFORM_STALE_DIGEST) {
    const details = (reply.body as { details?: { digest?: unknown } } | null)?.details;
    return { kind: 'stale', digest: typeof details?.digest === 'string' ? details.digest : null };
  }
  return { kind: 'retry', status: reply.status };
}

type HeldOutcome =
  | { kind: 'held'; urn: string; digest: string; state: string }
  | { kind: 'not-held' }
  | { kind: 'retry'; status: number | 'unreachable' };

/**
 * Whether a comment the platform holds hidden is hidden there by a moderator: the platform keeps one
 * moderator source, so only that hide would a lift from here clear. A pipeline or site hide is not.
 */
async function moderatorHidThere(
  held: HeldOutcome
): Promise<boolean | { retry: number | 'unreachable' }> {
  if (held.kind !== 'held' || held.state !== 'hidden') return false;
  let read: Awaited<ReturnType<typeof readDecidingVerdict>>;
  try {
    read = await readDecidingVerdict(held.urn);
  } catch (e) {
    if (e instanceof SignerUnavailableError) return { retry: 'unreachable' };
    throw e;
  }
  if ('failed' in read) return { retry: read.status };
  return read.verdict?.source === 'moderator' && read.verdict.verdict === 'hidden';
}

/** What the platform holds for a comment, by its sourceId: never its text. */
async function readBySource(sourceId: number): Promise<HeldOutcome> {
  let reply: SignerReply;
  try {
    reply = await callSigner(PLATFORM_COMMENT_BY_SOURCE_PATH, {
      method: 'GET',
      query: new URLSearchParams({ sourceId: String(sourceId) }),
    });
  } catch (e) {
    if (e instanceof SignerUnavailableError) return { kind: 'retry', status: 'unreachable' };
    throw e;
  }
  if (reply.status === 404 && signerErrorCode(reply) === PlatformRefusal.NotHeld)
    return { kind: 'not-held' };
  if (reply.status >= 200 && reply.status < 300) {
    const parsed = commentBySourceSchema.safeParse(reply.body);
    return parsed.success ? { kind: 'held', ...parsed.data } : { kind: 'retry', status: 200 };
  }
  if (isRouteMissing(reply))
    log('error', 'platform route missing', {
      path: PLATFORM_COMMENT_BY_SOURCE_PATH,
      status: reply.status,
    });
  return { kind: 'retry', status: reply.status };
}

/**
 * Deletes a comment the platform will not take, and its topic if nothing else is on it. One held,
 * not verified clear, or reported is evidence: hidden and kept instead. Either way it is recorded
 * refused, with nothing left to push.
 */
export async function refuseFpComment(commentId: number, topicId: number) {
  afterCommentsV3Deleted(
    await dbWrite.$transaction((tx) => refuseFpCommentIn(tx, commentId, topicId))
  );
}

/** refuseFpComment's writes, in the caller's transaction. */
export async function refuseFpCommentIn(
  tx: Prisma.TransactionClient,
  commentId: number,
  topicId: number
) {
  const db = prismaRunner(tx);
  // The hold decision's lock first, then the row: a hold cannot land between the check and the delete.
  await lockCsamHold(tx, 'CommentV3', commentId);
  const { rows: live } = await db.query(
    `SELECT id FROM "CommentV3" WHERE id = $1 AND "deletedAt" IS NULL FOR UPDATE`,
    [commentId]
  );
  if (!live.length) return [];
  if (
    (await hasOpenCommentReport(db, commentId)) ||
    (await commentV3CsamHold(commentId, tx)) !== 'clear'
  ) {
    await setCommentFlags(db, [commentId], { hidden: true });
    await db.query(
      `UPDATE "FeaturePageCommentMirror" SET "goneCause" = 'refused', "updatedAt" = now()
         WHERE "commentId" = $1 AND "goneCause" IS NULL`,
      [commentId]
    );
    return [];
  }
  const gone = await deleteCommentsV3(tx, [commentId], 'refused');
  // Locked first, emptiness read after: a post committed meanwhile is seen, one waiting is not lost.
  await db.query(`SELECT id FROM "FeaturePageTopic" WHERE id = $1 FOR UPDATE`, [topicId]);
  // The enum label is read only here, behind the flags, after the migration added it.
  await db.query(
    `DELETE FROM "FeaturePageTopic" t WHERE t.id = $1 AND NOT EXISTS (
         SELECT 1 FROM "CommentV3" c WHERE c."entityType" = 'featurePage' AND c."entityId" = t.id)`,
    [topicId]
  );
  return gone;
}

type PushResult = 'pushed' | 'failed' | 'stuck' | 'refused' | 'removed' | 'skipped';

/** A text post, without its key. `at` is the content's own time, the same on every retry. */
async function postBody(row: FpMirrorFactsRow) {
  const text = fpHtmlToText(row.content ?? '');
  const [masked] = await maskProfanityInChat([text]);
  return {
    uid: row.userId,
    sourceId: row.commentId,
    subject: row.subjectUrn,
    ...(row.parentUrn ? { parent: row.parentUrn } : {}),
    text,
    ...(typeof masked === 'string' ? { maskedText: masked } : {}),
    authorName: row.username ?? '',
    siteVerdict: 'visible',
    at: (row.contentAt ?? row.createdAt ?? new Date(0)).toISOString(),
  };
}

/**
 * One key per body and send: a retry of the same body reuses it, a changed body (text, name or
 * time) or a later send of an older body gets a new one, so no older reply is ever replayed.
 */
const textKey = (row: FpMirrorFactsRow, body: Record<string, unknown>) =>
  `c${row.commentId}:s${row.postSeq}:${createHash('sha256')
    .update(JSON.stringify(body))
    .digest('hex')
    .slice(0, 24)}`;

const retractAt = (row: FpMirrorFactsRow) =>
  (row.goneAt ?? row.contentAt ?? row.createdAt ?? new Date(0)).toISOString();

/** The platform refuses an all-digit or empty authorName. */
const sendableName = (username: string | null) => !!username && !/^\d+$/.test(username);

const retractAuthorName = (username: string | null) =>
  sendableName(username) ? username! : '[deleted]';

/**
 * Pushes what one row should hold now and records the outcome. Never inside a transaction: each
 * call is HTTP, and each record is its own statement. A due row always sends its state, whatever
 * was pushed before; it never sends a moderator's visible (only the reconcile does, for a lift).
 */
async function pushRow(e: Evaluated): Promise<PushResult> {
  const { row, state, postDigest } = e;
  const readAt = row.mirrorUpdatedAt;
  let platformDigest = row.platformDigest;
  let pushedDigest = row.pushedDigest;
  let postSeq = row.postSeq;
  let urn = row.urn;
  const sofar = () => ({ ...(urn ? { urn } : {}), platformDigest, pushedDigest, postSeq });
  // A park's marker is this push's own want, never an older one.
  const parkedFor = { parked: true, parkedWant: e.want, parkedRestricting: state !== 'visible' };
  const record = async (r: Omit<FpPushRecord, 'readAt'>, cas = true) => {
    try {
      await recordFpPush(kyselyWrite, row.commentId, { ...(cas ? { readAt } : {}), ...r });
    } catch (error) {
      if ((error as { code?: string }).code !== '23505' || !r.urn) throw error;
      // Another row already holds that urn: kept out of the push loop and in the stuck alert.
      log('error', 'urn conflict', { commentId: row.commentId, urn: r.urn });
      await recordFpPush(kyselyWrite, row.commentId, {
        readAt,
        nextPushAt: null,
        pushAttempts: Math.max(row.pushAttempts, FP_MAX_PUSH_ATTEMPTS),
        ...parkedFor,
      });
    }
  };
  const done = async (r: Partial<FpPushRecord> = {}, cas = true) => {
    await record(
      {
        ...sofar(),
        pushedState: state,
        nextPushAt: null,
        pushAttempts: 0,
        subjectMissing: false,
        ...r,
      },
      cas
    );
  };
  const fail = async (status: number | 'unreachable', step: string): Promise<PushResult> => {
    // Rate limited: due again after the current backoff, without spending an attempt.
    if (status === 429) {
      await record({ ...sofar(), nextPushAt: backoff(Math.max(row.pushAttempts, 1), false) });
      log('warning', 'push rate limited', { commentId: row.commentId, state, step });
      return 'failed';
    }
    const attempts = row.pushAttempts + 1;
    // Only a visible push gives up at the cap, and never one waiting for its feature subject.
    const next = backoff(attempts, state === 'visible' && !row.subjectMissingAt);
    // Given up: parked, so the dirty pass does not requeue it until what it should hold changes.
    await record({
      ...sofar(),
      nextPushAt: next,
      pushAttempts: attempts,
      ...(next ? {} : parkedFor),
    });
    const result = attempts >= FP_MAX_PUSH_ATTEMPTS ? 'stuck' : 'failed';
    log(result === 'stuck' ? 'error' : 'warning', `push ${result}`, {
      commentId: row.commentId,
      state,
      step,
      status,
      attempts,
    });
    return result;
  };
  const failed = (r: StepOutcome, step: string) =>
    fail(r.kind === 'retry' ? r.status : r.kind === 'stale' ? 409 : 0, step);
  // Due again later without spending an attempt; `counted` keeps it in the stuck alert meanwhile.
  const wait = async (minutes: number, why: string, counted = false): Promise<PushResult> => {
    await record({
      ...sofar(),
      nextPushAt: new Date(Date.now() + minutes * 60_000),
      ...(counted
        ? { pushAttempts: Math.max(row.pushAttempts, FP_MAX_PUSH_ATTEMPTS), subjectMissing: false }
        : {}),
    });
    log(counted ? 'error' : 'info', 'push waiting', { commentId: row.commentId, state, why });
    return 'skipped';
  };
  const erased = async () => {
    await markAuthorErased(row.userId);
    log('info', 'author erased on the platform', { commentId: row.commentId });
    return 'removed' as const;
  };
  // The platform holds a removal: final, and it also completes a retract.
  const removed = async (step: string) => {
    await done({
      pushedState: state === 'retracted' ? 'retracted' : 'mod-removed',
      removeWanted: true,
    });
    log('info', 'removed', { commentId: row.commentId, step });
    return 'removed' as const;
  };

  if (state === 'refused') {
    await done();
    return 'skipped';
  }
  if (state === 'erased') {
    const r = await send(PLATFORM_AUTHOR_ERASE_PATH, { uid: row.userId });
    if (r.kind !== 'ok' && r.kind !== 'erased') return failed(r, 'erase');
    await markAuthorErased(row.userId);
    log('info', 'pushed', { commentId: row.commentId, state, userId: row.userId });
    return 'pushed';
  }

  // Nothing is shown until a finished scan of its current text found nothing, or a moderator lifted
  // the scan's hide of that text, and only while its author is in standing.
  if (state === 'visible') {
    if ((await getTextScanMode('CommentV3', row.commentId)) !== 'active')
      return wait(SCAN_INACTIVE_WAIT_MINUTES, 'text scan not active');
    const scan = await currentTextScan(row.commentId);
    if (scan === 'not clean' && row.liftGrantedVersion !== row.version)
      return wait(UNRESOLVED_WAIT_MINUTES, 'current text scanned, not clean');
    if (scan === 'pending') return wait(SCAN_PENDING_WAIT_MINUTES, 'current text not scanned yet');
    if (!row.authorInStanding) return wait(STANDING_WAIT_MINUTES, 'author banned or muted');
  }

  const sendText = async () => {
    const body = await postBody(row);
    return send(PLATFORM_COMMENT_PATH, { ...body, idempotencyKey: textKey(row, body) });
  };
  // No idempotency key: a replayed one would write nothing, and a resent retract finishes a purge.
  const sendRetract = () =>
    send(PLATFORM_COMMENT_PATH, {
      uid: row.userId,
      sourceId: row.commentId,
      subject: row.subjectUrn,
      text: null,
      authorName: retractAuthorName(row.username),
      at: retractAt(row),
    });
  let sentAt = '';
  // Hidden there by a moderator when this mirror first hides it: another's hide, never lifted here.
  // Kept while the hide stands; only the read before a first hide decides it again.
  let foreign = row.pushedState === 'mod-hidden' && row.modHideOrigin === 'foreign';
  const modHide = () => ({
    modHide: {
      at: new Date(sentAt),
      origin: foreign
        ? ('foreign' as const)
        : row.scanHide
        ? ('scan' as const)
        : ('moderator' as const),
    },
  });
  /** A verdict at now, on any token: a stale one is resent on the token the platform names. */
  const verdict = async (path: string, value: string) => {
    const body = (digest: string | null) => ({
      target: { urn, digest },
      verdict: value,
      at: (sentAt = new Date().toISOString()),
    });
    let r = await send(path, body(platformDigest));
    if (r.kind === 'stale' && r.digest) {
      platformDigest = r.digest;
      r = await send(path, body(platformDigest));
    }
    return r;
  };
  const steps: string[] = [];

  if (state === 'visible') {
    const needsText = !urn || pushedDigest !== postDigest;
    const unsendable =
      needsText &&
      (fpHtmlToText(row.content ?? '').length > FEATURE_PAGES_TEXT_MAX_LENGTH ||
        !sendableName(row.username));
    if (unsendable) {
      // Never sent; any older text there is taken down until text the platform takes is posted.
      if (urn) {
        const r = await verdict(PLATFORM_SITE_VERDICT_PATH, 'hidden');
        if (r.kind === 'removed') return removed('takedown');
        if (r.kind === 'erased') return erased();
        if (r.kind !== 'ok') return failed(r, 'takedown');
        pushedDigest = null;
      }
      return wait(UNRESOLVED_WAIT_MINUTES, 'text or name the platform refuses', true);
    }
    if (needsText) {
      const first = !urn;
      if (first) {
        if (!row.subjectUrn) return fail(0, 'post');
        // A reply waits until its parent is on the platform, so it never lands at the top.
        if (row.parentId && !row.parentUrn)
          return wait(
            PARENT_WAIT_MINUTES,
            'parent not on the platform yet',
            // Counted once old, so a parent that never posts is in the stuck alert.
            !!row.createdAt &&
              Date.now() - row.createdAt.getTime() > UNRESOLVED_WAIT_MINUTES * 60_000
          );
        await markFpPostAttempted(kyselyWrite, row.commentId);
      }
      const r = await sendText();
      if (
        first &&
        r.kind === 'refused' &&
        (row.subjectUrn!.startsWith(FEATURE_PAGES_FEATURE_URN_PREFIX) || row.postAttemptedAt)
      ) {
        // A feature the platform does not hold yet, or an earlier send may have landed: it waits,
        // counted, never refused.
        const attempts = row.pushAttempts + 1;
        await record({
          ...sofar(),
          nextPushAt: backoff(attempts, false),
          pushAttempts: attempts,
          subjectMissing: true,
          clearPostAttempted: !row.postAttemptedAt,
        });
        log('info', 'push waiting', { commentId: row.commentId, why: 'unknown feature subject' });
        return 'skipped';
      }
      if (first && r.kind === 'refused') {
        // The local step first, so a failure there is retried before anything is recorded final.
        if (row.commentExists && row.topicId) await refuseFpComment(row.commentId, row.topicId);
        await done({ pushedState: 'refused' }, false);
        log('info', 'refused', { commentId: row.commentId });
        return 'refused';
      }
      if (r.kind === 'removed') return removed(first ? 'post' : 'repost');
      if (r.kind === 'erased') return erased();
      if (r.kind !== 'ok') return failed(r, first ? 'post' : 'repost');
      const parsed = commentPostReplySchema.safeParse(r.body);
      if (!parsed.success) return fail(200, 'post-reply');
      urn = parsed.data.urn;
      platformDigest = parsed.data.digest;
      if (parsed.data.stale) {
        pushedDigest = null;
        return fail(200, 'post-stale');
      }
      pushedDigest = postDigest;
      postSeq += 1;
      steps.push(first ? 'post' : 'repost');
    }
    // Always approved on the current token. A stale token is never approved: the text is posted
    // again first, so nothing approves text this push did not send.
    const r = await send(PLATFORM_SITE_VERDICT_PATH, {
      target: { urn, digest: platformDigest },
      verdict: 'visible',
      at: new Date().toISOString(),
    });
    if (r.kind === 'stale') {
      pushedDigest = null;
      return fail(409, 'site-visible-stale');
    }
    if (r.kind === 'removed') return removed('site-visible');
    if (r.kind === 'erased') return erased();
    if (r.kind !== 'ok') return failed(r, 'site-visible');
    steps.push('site-visible');
    await done();
    log('info', 'pushed', { commentId: row.commentId, state, prior: row.pushedState, steps });
    return 'pushed';
  }

  if (!urn) {
    // Never sent: nothing is on the platform to take away.
    if (!row.postAttemptedAt) {
      await done();
      return 'skipped';
    }
    // Sent, reply lost. A retract works by sourceId and returns the urn; a removal follows it.
    if (state === 'retracted' || state === 'mod-removed') {
      // Recorded before the first removal is sent: a lost reply must not leave it showable.
      if (state === 'mod-removed' && !row.removeWantedAt)
        await markFpRemoveWanted(kyselyWrite, row.commentId);
      const r = await sendRetract();
      if (r.kind === 'erased') return erased();
      if (r.kind === 'removed') return removed('lost-first-post');
      if (r.kind !== 'ok')
        return wait(UNRESOLVED_WAIT_MINUTES, 'lost first post: retract failed', true);
      const parsed = commentPostReplySchema.safeParse(r.body);
      if (!parsed.success || parsed.data.stale)
        return wait(UNRESOLVED_WAIT_MINUTES, 'lost first post: bad reply', true);
      urn = parsed.data.urn;
      platformDigest = parsed.data.digest;
      steps.push('retract');
      if (state === 'retracted') {
        await done();
        return 'pushed';
      }
    } else {
      const held = await readBySource(row.commentId);
      if (held.kind === 'retry') return fail(held.status, 'by-source');
      if (held.kind === 'held') {
        if (held.state === 'erased') return erased();
        if (state === 'mod-hidden' && row.pushedState !== 'mod-hidden') {
          const there = await moderatorHidThere(held);
          if (typeof there !== 'boolean') return fail(there.retry, 'verdict-source');
          foreign = there;
        }
        urn = held.urn;
        platformDigest = held.digest;
        steps.push('by-source');
      } else {
        // Not held yet: hidden ahead of its post, so a post that lands later is withheld.
        const r = await send(PLATFORM_MOD_VERDICT_PATH, {
          target: { sourceId: row.commentId },
          verdict: 'hidden',
          at: (sentAt = new Date().toISOString()),
        });
        if (r.kind === 'removed') return removed('mod-hidden-ahead');
        if (r.kind === 'erased') return erased();
        if (r.kind !== 'ok') return failed(r, 'mod-hidden-ahead');
        await done(modHide());
        log('info', 'pushed', { commentId: row.commentId, state, steps: ['mod-hidden-ahead'] });
        return 'pushed';
      }
    }
  }

  let hidAt = {};
  if (state === 'mod-hidden') {
    // The platform keeps one moderator source, newest wins, so a later lift of ours would clear a
    // hide someone else made before ours. Read once, before this mirror's first hide of it: a hide
    // that lands between this read and the send is not seen here.
    if (row.pushedState !== 'mod-hidden' && !steps.includes('by-source')) {
      const held = await readBySource(row.commentId);
      if (held.kind === 'retry') return fail(held.status, 'by-source');
      const there = await moderatorHidThere(held);
      if (typeof there !== 'boolean') return fail(there.retry, 'verdict-source');
      foreign = there;
    }
    const r = await verdict(PLATFORM_MOD_VERDICT_PATH, 'hidden');
    if (r.kind === 'removed') return removed('mod-hidden');
    if (r.kind === 'erased') return erased();
    if (r.kind !== 'ok') return failed(r, 'mod-hidden');
    steps.push('mod-hidden');
    hidAt = modHide();
  } else if (state === 'mod-removed') {
    if (!row.removeWantedAt) await markFpRemoveWanted(kyselyWrite, row.commentId);
    const r = await verdict(PLATFORM_MOD_VERDICT_PATH, 'removed');
    if (r.kind === 'removed') return removed('mod-removed');
    if (r.kind === 'erased') return erased();
    if (r.kind !== 'ok') return failed(r, 'mod-removed');
    steps.push('mod-removed');
  } else if (state === 'retracted') {
    const r = await sendRetract();
    if (r.kind === 'removed') return removed('retract');
    if (r.kind === 'erased') return erased();
    if (r.kind !== 'ok') return failed(r, 'retract');
    const parsed = commentPostReplySchema.safeParse(r.body);
    // stale: the platform wrote nothing.
    if (!parsed.success || parsed.data.stale) return fail(200, 'retract-reply');
    platformDigest = parsed.data.digest;
    steps.push('retract');
  }
  await done(state === 'mod-removed' ? { removeWanted: true } : hidAt);
  log('info', 'pushed', { commentId: row.commentId, state, prior: row.pushedState, steps });
  return 'pushed';
}

/** A scan verdict that finished for exactly this text. */
const finishedFor = (
  status: string | null | undefined,
  contentHash: string | null | undefined,
  hash: string
) => status === 'Succeeded' && contentHash === hash;

/**
 * The scan of the comment's current text: clean, finished and not clean (flagged, or failed), or
 * not yet in (none, in flight, or for older text).
 */
async function currentTextScan(commentId: number) {
  const hash = (await currentScanContentHashes('CommentV3', [commentId])).get(commentId);
  if (!hash) return 'pending' as const;
  const verdict = await readFpScanVerdict(kyselyWrite, commentId);
  if (finishedFor(verdict?.status, verdict?.contentHash, hash))
    return verdict!.flagged ? ('not clean' as const) : ('clean' as const);
  if (verdict?.status === 'Failed' && verdict.contentHash === hash) return 'not clean' as const;
  return 'pending' as const;
}

/** What the frame shows: shown on civitai, and pushed to the platform as shown. */
export async function isFpCommentShown(commentId: number) {
  const [row] = await readFpMirrorFacts(kyselyWrite, [commentId]);
  if (!row?.commentExists) return false;
  return evaluate(row).state === 'visible' && !!row.urn && row.pushedState === 'visible';
}

/**
 * The post path's one inline push, right after the insert commits. Returns 'refused' when the
 * platform does not know the subject (the comment is gone again), otherwise leaves any failure to
 * the cron. Does nothing while the mirror is braked.
 */
export async function pushNewFpComment(commentId: number) {
  if (!(await isFpMirrorOn())) return 'deferred' as const;
  if (!(await leaseFpMirrorRow(kyselyWrite, commentId))) return 'deferred' as const;
  const [row] = await readFpMirrorFacts(kyselyWrite, [commentId]);
  if (!row) return 'deferred' as const;
  try {
    const result = await pushRow(evaluate(row));
    return result === 'refused' ? ('refused' as const) : ('pushed' as const);
  } catch (error) {
    log('error', 'inline push threw', { commentId, error: (error as Error).message });
    return 'deferred' as const;
  }
}

const notMigrated = (job: string) => {
  log('info', 'heartbeat', { job, migrated: false });
  return { migrated: false as const };
};

export async function runFpMirror() {
  if (!(await fpMirrorTableExists(kyselyWrite))) return notMigrated('mirror');
  const on = await isFpMirrorOn();
  const marked = await markChangedFpRows();
  const overdue = await countFpOverduePushes(kyselyWrite, 0);
  log('info', 'heartbeat', { job: 'mirror', on, pending: overdue, marked });
  if (!on) return { on, pending: overdue, marked };

  const started = Date.now();
  const counts: Record<PushResult, number> = {
    pushed: 0,
    failed: 0,
    stuck: 0,
    refused: 0,
    removed: 0,
    skipped: 0,
  };
  const erasedUsers = new Set<number>();
  while (Date.now() - started < RUN_BUDGET_MS) {
    const ids = await leaseFpMirrorRows(kyselyWrite, LEASE_BATCH);
    if (!ids.length) break;
    let next = 0;
    for (; next < ids.length && Date.now() - started < RUN_BUDGET_MS; next++) {
      const id = ids[next];
      // Read right before its send, under the lease: a change since the lease is what goes out.
      const [row] = await readFpMirrorFacts(kyselyWrite, [id]);
      if (!row) continue;
      const e = evaluate(row);
      // One author.erase@1 per account, however many of its rows were due.
      if (e.state === 'erased' && erasedUsers.has(e.row.userId)) continue;
      const result = await pushRow(e).catch((error) => {
        log('error', 'push threw', { commentId: e.row.commentId, error: (error as Error).message });
        return 'failed' as const;
      });
      if (e.state === 'erased' && result === 'pushed') erasedUsers.add(e.row.userId);
      counts[result] += 1;
    }
    await releaseFpLeases(kyselyWrite, ids.slice(next));
    if (ids.length < LEASE_BATCH) break;
  }
  return { on, marked, ...counts };
}

/**
 * The sweep (not behind the mirror flag): re-queues the scans of live rows with no verdict for
 * their current text, and logs what the alerts watch.
 */
export async function runFpSweep() {
  if (!(await fpMirrorTableExists(kyselyWrite))) return notMigrated('sweep');
  const after = (await dbKV.get<number>(SWEEP_CURSOR_KEY, 0)) ?? 0;
  const candidates = await readFpScanCandidates(kyselyWrite, {
    olderThanMinutes: FP_SCAN_GRACE_MINUTES,
    alertMinutes: FP_ALERT_MINUTES,
    limit: SWEEP_LIMIT,
    after,
  });
  const settled = candidates.filter((c) => c.settled);
  // Past the last settled row, the next sweep starts again from the first.
  await dbKV.set(
    SWEEP_CURSOR_KEY,
    settled.length && candidates.length >= SWEEP_LIMIT ? settled[settled.length - 1].commentId : 0
  );
  const hashes = await currentScanContentHashes(
    'CommentV3',
    candidates.map((c) => c.commentId)
  );
  let requeued = 0;
  let unscanned = 0;
  let capped = 0;
  for (const c of candidates) {
    const hash = hashes.get(c.commentId);
    if (!hash) {
      // Nothing to scan it against (scanning off, or no prompt or label): unscanned all the same.
      if (c.overdue) unscanned += 1;
      continue;
    }
    if (finishedFor(c.scanStatus, c.scanContentHash, hash)) continue;
    if (c.overdue) unscanned += 1;
    const attempts = c.scanHash === hash ? c.scanAttempts : 0;
    if (attempts >= FP_MAX_SCAN_ATTEMPTS) {
      capped += 1;
      continue;
    }
    // A Pending row for the current text is a scan in flight; only a stale or missing one is redone.
    if (c.scanStatus === 'Pending' && c.scanContentHash === hash) continue;
    await recordFpScanAttempt(kyselyWrite, c.commentId, hash);
    queueScamScan({ entityType: 'CommentV3', entityId: c.commentId });
    requeued += 1;
  }

  const [overdue, restrictionsOverdue, stuck, subjects] = await Promise.all([
    countFpOverduePushes(kyselyWrite, FP_ALERT_MINUTES),
    countFpOverdueRestrictions(kyselyWrite, FP_ALERT_MINUTES),
    countFpStuckRows(kyselyWrite, FP_MAX_PUSH_ATTEMPTS),
    countFpSubjectWaits(kyselyWrite),
  ]);
  const counts = {
    requeued,
    unscanned,
    capped,
    overdue,
    restrictionsOverdue,
    stuck,
    subjectWaiting: subjects.waiting,
    subjectWaitMinutes: subjects.oldestMinutes,
  };
  log(
    restrictionsOverdue || subjects.oldestMinutes > SUBJECT_WAIT_ALERT_MINUTES ? 'error' : 'info',
    'heartbeat',
    { job: 'sweep', ...counts }
  );
  return counts;
}

/** What the readback says the platform shows for one urn. */
function observed(item: PlatformCommentItem) {
  if (item.retracted) return 'retracted' as const;
  if (item.removed || item.verdict?.verdict === 'removed') return 'removed' as const;
  return item.verdict?.verdict ?? null;
}

const FINAL_STATES: readonly FpCommentState[] = ['mod-removed', 'retracted', 'erased', 'refused'];

/**
 * What a reconcile does about one row not already due, from what it should hold now and what the
 * platform shows: null when they agree or nothing is to be done.
 */
export function reconcileAction(
  e: Evaluated,
  item: PlatformCommentItem
):
  | FpReconcileAction
  | 'counted'
  | 'pipeline-hidden'
  | 'moderator-hidden'
  | 'lift'
  | 'moderator-lift'
  | null {
  const seen = observed(item);
  const textHeld = seen !== 'retracted' && seen !== 'removed';
  if (e.state === 'refused') return null;
  if (seen === 'removed')
    return e.state === 'mod-removed' || e.state === 'retracted' || e.state === 'erased'
      ? null
      : 'removeWanted';
  if (FINAL_STATES.includes(e.state)) return textHeld ? 'restrict' : null;
  if (e.state === 'mod-hidden') return seen === 'visible' ? 'restrict' : null;
  // Retracted there is final: its text is never sent again.
  if (seen === 'retracted') return 'counted';
  // Hidden there by the moderator hide sent here for the scan, which a moderator here has since
  // lifted for this text: matched on its `at`, so a platform moderator's own hide never is.
  if (
    seen === 'hidden' &&
    item.verdict?.source === 'moderator' &&
    e.row.liftGranted &&
    e.row.authorInStanding &&
    !!e.row.modHideSentAt &&
    Date.parse(item.verdict.at ?? '') === e.row.modHideSentAt.getTime()
  )
    return 'moderator-lift';
  if (seen === 'hidden' && item.verdict?.source === 'pipeline') return 'pipeline-hidden';
  // Visible: a takedown's tombstone or another post moved the token, so the text goes again.
  if (item.digest && item.digest !== e.row.platformDigest) return 'repost';
  if (seen === null) return 'due';
  if (seen === 'hidden' && item.verdict?.source === 'site') {
    // The site's own hide outlasted its lift (a tie, or a lift stamped by a clock behind): lifted
    // again at a fresh time, which wins only over a hide no newer than now.
    const hiddenAt = Date.parse(item.verdict.at ?? '');
    return Number.isNaN(hiddenAt) || hiddenAt <= Date.now() ? 'lift' : 'counted';
  }
  // Hidden on the platform by its own moderator: never answered.
  if (seen === 'hidden') return 'moderator-hidden';
  return null;
}

const FP_MAX_LIFTS = 3;
const FP_LIFTS_WINDOW_SECONDS = 30 * 24 * 60 * 60;

/**
 * A lift that lost is sent again up to FP_MAX_LIFTS times, then counted stuck. The count lives on
 * the cache cluster: an eviction restarts it, so a lift that keeps losing can be sent more often,
 * at most once a reconcile.
 */
const takeLift = (commentId: number, by?: number) =>
  takeClusterWindowCount(
    'feature-pages.lift',
    `${REDIS_KEYS.COUNTERS.FEATURE_PAGES_LIFTS}:${commentId}`,
    FP_LIFTS_WINDOW_SECONDS,
    { by }
  );

/**
 * The key just before `key` in the platform's key order, so the page after it starts at `key`. A
 * comment key is 32 lowercase hex (HMAC-SHA256 of its sourceId, truncated): one less, at the same
 * width, has no key between it and `key`; the all-zero key pages from the start. Any other shape
 * falls back to `key` short of its last character, which another key can sort between, and then the
 * read names that one and confirms nothing.
 */
export function keyBefore(key: string) {
  if (/^0+$/.test(key)) return '';
  if (!/^[0-9a-f]+$/.test(key)) return key.slice(0, -1);
  const digits = key.split('');
  let i = digits.length - 1;
  while (digits[i] === '0') digits[i--] = 'f';
  digits[i] = (parseInt(digits[i], 16) - 1).toString(16);
  return digits.join('');
}

/** The comments page that holds exactly the comment `urn`. */
export function singleCommentQuery(urn: string) {
  return new URLSearchParams({
    app: PLATFORM_FEATURE_PAGES_APP,
    limit: '1',
    cursor: keyBefore(urn.slice(urn.lastIndexOf('/') + 1)),
  });
}

/** The platform's deciding verdict on one comment: a one-item page from keyBefore(its key). */
async function readDecidingVerdict(
  urn: string
): Promise<{ verdict: PlatformCommentItem['verdict'] } | { failed: string; status: number }> {
  const reply = await callSigner(PLATFORM_COMMENTS_READ_PATH, {
    method: 'GET',
    query: singleCommentQuery(urn),
  });
  const page = commentsPageSchema.safeParse(reply.body);
  if (reply.status !== 200 || !page.success)
    return { failed: `read failed: ${reply.status}`, status: reply.status };
  const [item] = page.data.items;
  if (item?.urn !== urn)
    return { failed: item ? 'another comment read' : 'nothing read', status: reply.status };
  return { verdict: item.verdict };
}

/**
 * Why the platform's deciding verdict for this row is not confirmed as the moderator hide sent from
 * here, or null when it is.
 */
async function unconfirmedLift(row: FpMirrorFactsRow) {
  if (!row.urn || !row.modHideSentAt) return 'no hide sent';
  const read = await readDecidingVerdict(row.urn);
  if ('failed' in read) return read.failed;
  const v = read.verdict;
  if (v?.source !== 'moderator' || v.verdict !== 'hidden') return 'not a moderator hide';
  if (Date.parse(v.at ?? '') !== row.modHideSentAt.getTime()) return 'not the hide sent from here';
  return null;
}

/**
 * The platform's moderator visible for a lift, by sourceId: it lifts the moderator hide and decides
 * for no version, so the site and the pipeline decide after it, a pipeline hide included. Sent under
 * the row's lease, from facts read under it, so a hide made since the page was read goes first.
 * 'held': someone has reported it since the lift, so it stays hidden there until that is handled.
 */
async function sendModeratorLift(commentId: number, item: PlatformCommentItem) {
  if (!(await leaseFpMirrorRow(kyselyWrite, commentId))) return 'skipped' as const;
  try {
    const [row] = await readFpMirrorFacts(kyselyWrite, [commentId]);
    if (!row || row.nextPushAt || reconcileAction(evaluate(row), item) !== 'moderator-lift')
      return 'skipped' as const;
    if (
      await hasOpenPersonFpReport(kyselyWrite, {
        commentId,
        systemUserId: constants.system.user.id,
      })
    )
      return 'held' as const;
    // Confirmed again just before the send, as the page may be minutes old: only while the platform's
    // deciding verdict is still the moderator hide sent from here. Anything else sends nothing.
    const unconfirmed = await unconfirmedLift(row);
    if (unconfirmed) {
      log('warning', 'moderator lift unconfirmed', { commentId, reason: unconfirmed });
      return 'unconfirmed' as const;
    }
    const r = await send(PLATFORM_MOD_VERDICT_PATH, {
      target: { sourceId: commentId },
      verdict: 'visible',
      at: new Date().toISOString(),
    });
    if (r.kind !== 'ok') {
      log('error', 'moderator lift failed', { commentId, kind: r.kind });
      return 'skipped' as const;
    }
    await markFpReconciled(kyselyWrite, commentId, 'due');
    return 'sent' as const;
  } finally {
    await releaseFpLeases(kyselyWrite, [commentId]);
  }
}

/** The daily reconcile: compares what each urn should hold with the platform, by reconcileAction. */
export async function runFpReconcile() {
  if (!(await fpMirrorTableExists(kyselyWrite))) return notMigrated('reconcile');
  // Braked, it still reads and logs, and marks nothing.
  const on = await isFpMirrorOn();
  let cursor: string | null = null;
  let checked = 0;
  let mismatched = 0;
  let pipelineHidden = 0;
  let moderatorHidden = 0;
  let liftsLost = 0;
  let moderatorLifts = 0;
  let liftsHeld = 0;
  let liftsUnconfirmed = 0;
  do {
    const query = new URLSearchParams({
      app: PLATFORM_FEATURE_PAGES_APP,
      limit: String(PLATFORM_COMMENTS_PAGE_LIMIT),
    });
    if (cursor) query.set('cursor', cursor);
    const reply = await callSigner(PLATFORM_COMMENTS_READ_PATH, { method: 'GET', query });
    const page = commentsPageSchema.safeParse(reply.body);
    if (reply.status !== 200 || !page.success) {
      log('error', 'reconcile read failed', { status: reply.status, checked });
      return {
        on,
        checked,
        mismatched,
        pipelineHidden,
        moderatorHidden,
        liftsLost,
        moderatorLifts,
        liftsHeld,
        liftsUnconfirmed,
        failed: true,
      };
    }
    const byUrn = await readFpMirrorByUrns(
      kyselyWrite,
      page.data.items.map((i) => i.urn)
    );
    const facts = new Map(
      (
        await readFpMirrorFacts(
          kyselyWrite,
          byUrn.map((m) => m.commentId)
        )
      ).map((row) => [row.urn, row])
    );
    for (const item of page.data.items) {
      const row = facts.get(item.urn);
      if (!row) continue;
      checked += 1;
      // A row already due is pushed from current facts anyway.
      if (row.nextPushAt) continue;
      const e = evaluate(row);
      const action = reconcileAction(e, item);
      if (!action) continue;
      if (action === 'pipeline-hidden') {
        pipelineHidden += 1;
        continue;
      }
      if (action === 'moderator-hidden') {
        moderatorHidden += 1;
        continue;
      }
      mismatched += 1;
      log('warning', 'mismatched', {
        commentId: row.commentId,
        expected: e.state,
        observed: observed(item),
        action,
      });
      if (!on || action === 'counted') continue;
      if (action === 'moderator-lift') {
        const lifted = await sendModeratorLift(row.commentId, item);
        if (lifted === 'sent') moderatorLifts += 1;
        else if (lifted === 'held') liftsHeld += 1;
        else if (lifted === 'unconfirmed') liftsUnconfirmed += 1;
        continue;
      }
      if (action !== 'lift') {
        await markFpReconciled(kyselyWrite, row.commentId, action);
        continue;
      }
      // Counter unreadable: send nothing this pass; the next reconcile finds the row again.
      const lifts = await takeLift(row.commentId).catch(() => NaN);
      if (Number.isNaN(lifts)) continue;
      if (lifts <= FP_MAX_LIFTS) {
        // Counted only if this marks it due: a row another writer made due first sends no lift.
        let marked = false;
        try {
          marked = await markFpReconciled(kyselyWrite, row.commentId, 'due');
        } finally {
          if (!marked) await takeLift(row.commentId, -1).catch(() => undefined);
        }
      } else {
        liftsLost += 1;
        log('error', 'lift lost', { commentId: row.commentId });
        await markFpReconciled(kyselyWrite, row.commentId, 'stuck', FP_MAX_PUSH_ATTEMPTS);
      }
    }
    cursor = page.data.next;
  } while (cursor);
  const counts = {
    on,
    checked,
    mismatched,
    pipelineHidden,
    moderatorHidden,
    liftsLost,
    moderatorLifts,
    liftsHeld,
    liftsUnconfirmed,
  };
  log('info', 'heartbeat', { job: 'reconcile', ...counts });
  return counts;
}

async function readVisibleFpUrns() {
  const visible: PlatformCommentItem[] = [];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({
      app: PLATFORM_FEATURE_PAGES_APP,
      limit: String(PLATFORM_COMMENTS_PAGE_LIMIT),
    });
    if (cursor) query.set('cursor', cursor);
    const reply = await callSigner(PLATFORM_COMMENTS_READ_PATH, { method: 'GET', query });
    const page = commentsPageSchema.safeParse(reply.body);
    if (reply.status !== 200 || !page.success)
      throw new Error(`platform readback failed: ${reply.status}`);
    visible.push(
      ...page.data.items.filter(
        (i) => !i.retracted && !i.removed && (!i.verdict || i.verdict.verdict === 'visible')
      )
    );
    cursor = page.data.next;
  } while (cursor);
  return visible;
}

/**
 * The runbook's last resort before the mirror itself is removed: with the mirror braked and its
 * leases run out, records a removal owed on every row, then removes every comment the platform may
 * hold text for (verdict.mod@1 removed), hidden ones included, and reads back. Rows sent but never
 * answered have no urn to aim at: they are reported as remaining. A dry run only counts.
 */
export async function hideAllFpComments({ execute }: { execute: boolean }) {
  if (await isFpMirrorOn()) throw new Error('Brake the mirror (featurePagesMirror off) first.');
  let counts = await readFpRunbookCounts(kyselyWrite);
  for (let waited = 0; counts.leased && waited < LEASE_DRAIN_MS; waited += 5_000) {
    await sleep(5_000);
    counts = await readFpRunbookCounts(kyselyWrite);
  }
  if (counts.leased) throw new Error(`${counts.leased} push(es) still leased; run again shortly.`);
  const visible = (await readVisibleFpUrns()).length;
  if (!execute)
    return {
      targets: counts.targets,
      visible,
      removed: 0,
      failed: 0,
      remaining: visible + counts.unreachable,
    };
  const marked = await markFpRunbookRemoval(kyselyWrite);
  const targets = await readFpMirrorFacts(
    kyselyWrite,
    marked.filter((m) => m.reachable).map((m) => m.commentId)
  );
  let removed = 0;
  let failed = 0;
  for (const row of targets) {
    const r = await send(PLATFORM_MOD_VERDICT_PATH, {
      target: { urn: row.urn, digest: row.platformDigest },
      verdict: 'removed',
      at: new Date().toISOString(),
    });
    if (r.kind === 'ok' || r.kind === 'removed' || r.kind === 'erased') {
      removed += 1;
      const state = evaluate(row).state;
      // Left due: only the push's author.erase completes an erasure.
      if (state !== 'erased')
        await recordFpPush(kyselyWrite, row.commentId, {
          pushedState: state,
          nextPushAt: null,
          pushAttempts: 0,
        });
    } else failed += 1;
  }
  const remaining = (await readVisibleFpUrns()).length + counts.unreachable;
  log(remaining || failed ? 'error' : 'info', 'hide-all', {
    targets: targets.length,
    removed,
    failed,
    unreachable: counts.unreachable,
    remaining,
  });
  return { targets: targets.length, visible, removed, failed, remaining };
}
