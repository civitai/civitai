import { type ActionFailure, fail } from '@sveltejs/kit';
import { isBlockReason } from '$lib/block-reasons';
import { db } from '$lib/server/db';
import { openItem } from '$lib/server/feed-token';
import { imageUrl, THUMBNAIL_WIDTH } from '$lib/server/image-url';
import { metrics } from '$lib/server/metrics';
import {
  answerHiddenCheck,
  dismissHiddenNotices,
  parseNoticeKeys,
  hiddenItemId,
  readHiddenNotices,
} from '$lib/server/hidden/hidden.service';
import { DISMISS_FAILED } from '$lib/notice-copy';
import { consented, consentFailure, requireConsent, requireMember } from '$lib/server/membership';
import { getPlayerStatus } from '$lib/server/player-status';
import { isRank, RANK_RULES } from '$lib/server/ranks';
import { getStanding, mutedFailure } from '$lib/server/standing';
import { rankTable } from '$lib/server/progression/rating';
import { ratingGuide } from '$lib/server/rules';
import { ratingExamples, withExamples } from '$lib/server/rating-examples';
import {
  dismissGuide,
  dismissProgress,
  dismissWhatsNew,
  readNotices,
  type ProgressNotice,
} from '$lib/server/seen';
import { seenStore } from '$lib/server/seen-runtime';
import { skipStore } from '$lib/server/skip-runtime';
import { recordSkip, skippedFor } from '$lib/server/skips';
import { creditLateJudgment } from '$lib/server/queue/vote-record';
import { stagesWorkedBy } from '$lib/server/queue/ranks';
import { announceMoves, itemStages, playDaily } from '$lib/server/live/announce';
import { signalsEnabled } from '$lib/server/live/signals';
import { STALE_REASONS } from './optimistic';
import { railFor } from '$lib/server/rail-runtime';
import { castVote, type RejectReason } from '$lib/server/queue/queue.service';
import { queueDeps } from '$lib/server/queue/runtime';
import { lockoutFor, voteGate } from '$lib/server/vote-limits/runtime';
import { hiddenSettings } from '$lib/server/hidden/runtime';
import { feedSecret, resetDeps } from '$lib/server/smites/runtime';
import { dismissResetNotice, hasUnseenReset } from '$lib/server/smites/smites.service';
import { castYesNoVote } from '$lib/server/yesno/vote';
import { apprenticeDeps } from '$lib/server/apprenticeship/runtime';
import { crossedMilestone } from '$lib/server/apprenticeship/standing';
import { acolyteLevelGoldSince } from '$lib/server/apprenticeship/level-gold';
import {
  acknowledgeCheckpoint,
  answerApprentice,
  getApprentice,
  getApprenticeProgress,
} from '$lib/server/apprenticeship/apprenticeship.service';
import { isReturningPlayer, whatsNewCopy } from '$lib/whats-new';
import { pickItem } from './next-item.server';
import { apprenticePayload, progressPayload } from './apprentice';
import type { Actions, PageServerLoad } from './$types';

const BLOCK_REASON_TEXT = 'Choose a reason from the list when you block an image.';

const REJECTION_TEXT: Record<RejectReason, string> = {
  'no-player': 'You have not joined the Order yet.',
  'not-eligible': 'You cannot judge this one yet.',
  'bad-answer': 'That answer is not on offer.',
  'bad-block-reason': BLOCK_REASON_TEXT,
  'already-voted': 'You have already judged this one.',
  'own-image': 'You cannot judge your own image.',
  'not-open': 'This one has already been settled.',
  unavailable: 'This one is not open for judging.',
  'no-weight': 'Your standing is too low for your judgment to count yet.',
  'reset-pending': 'Your career is being reset. Return in a moment.',
};

const APPRENTICE_REJECTION_TEXT = {
  'no-player': 'You have not joined the Order yet.',
  'not-acolyte': 'Your apprenticeship is over.',
  'reset-pending': 'Your career is being reset. Return in a moment.',
  'checkpoint-pending': 'Take a look at your recap first.',
  'not-current': 'That is not the image before you now.',
  'bad-answer': 'That answer is not on offer.',
} as const;

type Perks = { goldMultiplier: number };
type RankPerks = {
  levels?: string;
  goldMultiplier?: number;
  /** The perks of the rank the player held before, for the rank-up's "what changed". */
  previous?: Perks;
};
type Notice = ProgressNotice &
  RankPerks & { milestone?: string; milestoneLevel?: number; levelGold?: number };

const perksOf = (rank: string): Perks | undefined =>
  isRank(rank) ? { goldMultiplier: RANK_RULES[rank].goldMultiplier } : undefined;

// A rank-up notice says what the rank brings and what it replaces; a level-up carries nothing more.
function withRankPerks(progress: ProgressNotice | null): Notice | null {
  if (progress?.kind !== 'rank') return progress;
  const perks = rankTable().find((entry) => entry.rank === progress.rank);
  if (!perks) return progress;
  return {
    ...progress,
    levels: perks.levels,
    goldMultiplier: perks.goldMultiplier,
    previous: perksOf(progress.fromRank),
  };
}

// Every Acolyte level gets a card; levels 5, 10 and 15 carry the milestone words. Its gold is the levels since the one the
// player last saw, up to the level the card shows, so it does not grow while the card is open.
async function acolyteLevelCard(progress: Notice | null, userId: number): Promise<Notice | null> {
  if (progress?.kind !== 'level') return progress;
  const milestone = crossedMilestone(progress.from, progress.level);
  const shown = milestone?.level ?? progress.level;
  const levelGold = await acolyteLevelGoldSince(db, userId, progress.from, shown);
  return milestone
    ? { ...progress, milestone: milestone.copy, milestoneLevel: milestone.level, levelGold }
    : { ...progress, levelGold };
}

export const load: PageServerLoad = async ({ locals, depends }) => {
  depends('app:play');
  const [status, { muted }] = await Promise.all([
    requireMember(db, locals.user.id),
    getStanding(db, locals.user.id),
  ]);
  await requireConsent(locals.user.id);
  const now = queueDeps.now();
  const [resetNotice, notices, seen, examples] = await Promise.all([
    hasUnseenReset(db, locals.user.id, now),
    readHiddenNotices(db, locals.user.id),
    readNotices(seenStore, locals.user.id, status),
    ratingExamples(db),
  ]);
  const common = {
    status,
    muted,
    resetNotice,
    notices: notices.map((notice) => ({
      ...notice,
      imageSrc: notice.imageKey ? imageUrl(notice.imageKey, THUMBNAIL_WIDTH) : null,
    })),
    whatsNew: seen.whatsNew ? whatsNewCopy(isReturningPlayer(status)) : null,
    showGuide: seen.guide,
    progress: withRankPerks(seen.progress),
    ratingGuide: withExamples(ratingGuide(), examples),
  };

  // An Acolyte whose career reset is due falls through to the queue page, which serves nothing until it lands.
  if (status.rank === 'Acolyte' && !muted && !(status.smites >= status.maxSmites)) {
    const view = await getApprentice(db, locals.user.id);
    if (view.kind !== 'not-acolyte') {
      return {
        mode: 'apprentice' as const,
        ...common,
        progress: await acolyteLevelCard(common.progress, locals.user.id),
        apprentice: apprenticePayload(view),
      };
    }
  }

  // A muted player sees their record but is served nothing to judge: no item, no vote-pace lookup.
  const lockedUntil =
    !muted && !locals.user.isModerator ? await lockoutFor(db, locals.user.id, now) : null;
  const skipped = lockedUntil || muted ? null : await skippedFor(skipStore, locals.user.id);
  const resetPending = status.smites >= status.maxSmites;
  // A muted Acolyte keeps the apprentice meter (read only: the apprenticeship serves them nothing to answer).
  const mutedApprentice = muted && status.rank === 'Acolyte';
  const [picked, daily, rail, apprenticeMeter] = await Promise.all([
    lockedUntil || muted || resetPending ? null : pickItem(locals.user.id, status.rank, skipped),
    playDaily(db, locals.user.id, status, now),
    railFor(locals.user.id, now, status.fervor),
    mutedApprentice
      ? getApprenticeProgress(db, locals.user.id).then(progressPayload)
      : Promise.resolve(null),
  ]);
  const lockoutSeconds = lockedUntil
    ? Math.max(1, Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000))
    : null;
  return {
    mode: 'queue' as const,
    banner: picked?.banner ?? null,
    category: picked?.category ?? null,
    ...common,
    daily,
    live: { at: now.getTime(), stages: stagesWorkedBy(status.rank) },
    rail,
    resetPending,
    apprenticeMeter,
    lockoutSeconds,
    question: picked?.question ?? null,
    item: picked?.item ?? null,
  };
};

/**
 * The milestone card is for the item it appeared with: the page flags an answer (or the recap's Continue) given while it
 * was on screen, and the standing it showed, read before the answer moves it, is recorded as seen. A milestone this very
 * answer crosses still gets its own card. Never fails the answer: a read or store that is down leaves the card up.
 */
async function standingOnCard(form: FormData, userId: number) {
  if (form.get('noticeShown') !== '1') return null;
  try {
    const status = await getPlayerStatus(db, userId);
    return status ? { rank: status.rank, level: status.level } : null;
  } catch (error) {
    console.error('knights: could not read the standing behind the level notice', {
      userId,
      error,
    });
    return null;
  }
}

/** A pace refusal. Its end is frozen first, so this countdown, the page's and every later refusal's are one end. */
async function limitedFailure(userId: number, until: Date) {
  const now = queueDeps.now();
  const end = await voteGate.freeze(userId, now, until);
  return fail(429, {
    message: 'You are judging too quickly. Rest a little.',
    lockoutSeconds: Math.max(1, Math.ceil((end.getTime() - now.getTime()) / 1000)),
  });
}

const busyFailure = () =>
  fail(429, { message: 'The Order is catching up. Try that answer again.', busy: true });

type VoteEvent = { request: Request; locals: App.Locals };

type ParsedVote = {
  ref: NonNullable<ReturnType<typeof openItem>>;
  answer: string;
  blockReason: string | null;
  itemId: number;
};

/** Reads and checks the form without touching the database, so only real vote attempts reach the limits. */
async function readVote({
  request,
  locals,
}: VoteEvent): Promise<
  { failure: ActionFailure<{ message: string }>; reason?: string } | ParsedVote
> {
  const form = await request.formData();
  const token = form.get('item');
  const answer = form.get('answer');
  const reasonField = form.get('blockReason');
  if (typeof token !== 'string') {
    return { failure: fail(400, { message: 'Pick an answer.' }), reason: 'bad-token' };
  }
  if (typeof answer !== 'string') {
    return { failure: fail(400, { message: 'Pick an answer.' }), reason: 'bad-answer' };
  }
  if (reasonField !== null && typeof reasonField !== 'string') {
    return { failure: fail(400, { message: BLOCK_REASON_TEXT }), reason: 'bad-block-reason' };
  }
  const blockReason = reasonField === '' ? null : reasonField;
  if (blockReason !== null && !isBlockReason(blockReason)) {
    return { failure: fail(400, { message: BLOCK_REASON_TEXT }), reason: 'bad-block-reason' };
  }
  let ref: ReturnType<typeof openItem>;
  try {
    ref = openItem(feedSecret(), locals.user.id, token);
  } catch (error) {
    console.error('knights: the feed cannot be served', { error });
    return {
      failure: fail(500, {
        message: 'Your judgment could not be recorded. Try again in a moment.',
      }),
    };
  }
  if (!ref) return { failure: fail(400, { message: 'Pick an answer.' }), reason: 'bad-token' };
  const itemId = ref.id;
  if (ref.kind === 'yesno' && blockReason !== null) {
    return { failure: fail(400, { message: BLOCK_REASON_TEXT }), reason: 'bad-block-reason' };
  }
  return { ref, answer, blockReason, itemId };
}

const kindOf = (ref: ParsedVote['ref']) =>
  ref.kind === 'hidden' ? 'hidden_check' : ref.kind === 'yesno' ? 'yesno' : 'rating';

/** Logs and meters a refused vote under its ledger item id: a hidden check's is the negative of its reference id. */
function refused(reason: string, vote: Pick<ParsedVote, 'ref' | 'itemId'> | null, userId: number) {
  metrics.voteRefused(
    reason,
    vote ? kindOf(vote.ref) : 'unknown',
    userId,
    vote ? (vote.ref.kind === 'hidden' ? hiddenItemId(vote.itemId) : vote.itemId) : null,
    'vote'
  );
}

/** A rating judgment on an item that settled while it waited in the buffer still counts toward the Daily Watch. */
async function creditLate(userId: number, itemId: number, answer: string): Promise<boolean> {
  try {
    return await creditLateJudgment(db, { userId, itemId, answer, now: queueDeps.now() });
  } catch (error) {
    console.error('knights: could not count a late judgment toward the Watch', {
      userId,
      itemId,
      error,
    });
    return false;
  }
}

async function recordVote({ ref, answer, blockReason, itemId }: ParsedVote, { locals }: VoteEvent) {
  try {
    const before =
      ref.kind === 'hidden' || !(await signalsEnabled().catch(() => false))
        ? []
        : await itemStages(db, [itemId]).catch(() => []);
    const result =
      ref.kind === 'hidden'
        ? await answerHiddenCheck(
            db,
            {
              userId: locals.user.id,
              referenceId: itemId,
              answer,
              blockReason,
              isModerator: locals.user.isModerator,
            },
            // Graded in this request, so the warning or smite shows on the answer that caused it.
            { ...queueDeps, grade: { settings: await hiddenSettings(), ...resetDeps } }
          )
        : ref.kind === 'yesno'
        ? await castYesNoVote(
            db,
            { userId: locals.user.id, itemId, answer, isModerator: locals.user.isModerator },
            queueDeps
          )
        : await castVote(
            db,
            {
              userId: locals.user.id,
              itemId,
              answer,
              blockReason,
              isModerator: locals.user.isModerator,
            },
            queueDeps
          );
    void announceMoves(db, before);
    if (result.status === 'limited') {
      refused('limited', { ref, itemId }, locals.user.id);
      return await limitedFailure(locals.user.id, result.until);
    }
    if (result.status === 'rejected') {
      refused(result.reason, { ref, itemId }, locals.user.id);
      const watchCounted =
        ref.kind === 'queue' &&
        STALE_REASONS.has(result.reason) &&
        (await creditLate(locals.user.id, itemId, answer));
      return fail(result.reason === 'bad-block-reason' ? 400 : 409, {
        message: REJECTION_TEXT[result.reason],
        reason: result.reason,
        ...(watchCounted ? { watchCounted } : {}),
      });
    }
    return 'check' in result && result.check
      ? { success: true, check: result.check }
      : { success: true };
  } catch (error) {
    console.error('knights: vote failed', { itemId, error });
    return fail(500, { message: 'Your judgment could not be recorded. Try again in a moment.' });
  }
}

export const actions: Actions = {
  // Every kind of vote (rating, yes/no, hidden check) passes the Redis vote limits here, before any database work.
  vote: async (event) => {
    const userId = event.locals.user.id;
    if ((await getStanding(db, userId)).muted) {
      refused('muted', null, userId);
      return mutedFailure();
    }
    if (!(await consented(userId))) {
      refused('no-consent', null, userId);
      return consentFailure();
    }
    const parsed = await readVote(event);
    if ('failure' in parsed) {
      if (parsed.reason) refused(parsed.reason, null, userId);
      return parsed.failure;
    }
    const outcome = await voteGate.guard(userId, queueDeps.now(), () => recordVote(parsed, event), {
      moderator: event.locals.user.isModerator,
    });
    if (!('until' in outcome)) return outcome;
    refused(outcome.busy ? 'busy' : 'limited', parsed, userId);
    if (outcome.busy) return busyFailure();
    let until = outcome.until;
    if (outcome.tripped) {
      // A window that trips now can sit inside a longer ledger lock: the pause is the later of the two.
      try {
        until = (await lockoutFor(db, userId, queueDeps.now())) ?? until;
      } catch (error) {
        console.error('knights: could not read the vote lockout', { userId, error });
      }
    }
    return limitedFailure(userId, until);
  },

  // Moves a player past an item without judging it: no vote, pay, accuracy or Watch credit, and it is not served to them
  // again. Every kind of item is handled and answered alike, so a skip does not show what the item was.
  skip: async ({ request, locals }) => {
    const skipRefused = (reason: string) =>
      metrics.voteRefused(reason, 'unknown', locals.user.id, null, 'skip');
    if ((await getStanding(db, locals.user.id)).muted) {
      skipRefused('muted');
      return mutedFailure();
    }
    if (!(await consented(locals.user.id))) {
      skipRefused('no-consent');
      return consentFailure();
    }
    const token = (await request.formData()).get('item');
    let ref: ReturnType<typeof openItem> = null;
    try {
      if (typeof token === 'string') ref = openItem(feedSecret(), locals.user.id, token);
    } catch (error) {
      console.error('knights: the feed cannot be served', { error });
    }
    if (!ref) {
      skipRefused('bad-token');
      return fail(400, { message: 'That one cannot be skipped.' });
    }
    await recordSkip(skipStore, locals.user.id, ref, queueDeps.now());
    return { success: true };
  },

  // The toast posts the keys it showed, so a check graded meanwhile stays unseen; a page without them dismisses all.
  dismissNotices: async ({ locals, request }) => {
    try {
      const posted = (await request.formData())
        .getAll('notice')
        .filter((key) => typeof key === 'string');
      const shown = posted.length > 0 ? parseNoticeKeys(posted) : undefined;
      await dismissHiddenNotices(db, locals.user.id, queueDeps.now(), shown);
    } catch (error) {
      console.error('knights: could not store the notice dismissal', { error });
      return fail(500, { message: DISMISS_FAILED, noticeFailed: true });
    }
  },

  dismissResetNotice: async ({ locals }) => {
    try {
      await dismissResetNotice(db, locals.user.id, queueDeps.now());
    } catch (error) {
      console.error('knights: could not store the reset notice dismissal', { error });
      return fail(500, {
        message: DISMISS_FAILED,
        resetNoticeFailed: true,
      });
    }
  },

  dismissGuide: async ({ locals }) => {
    const status = await requireMember(db, locals.user.id);
    if (!(await dismissGuide(seenStore, locals.user.id, status))) {
      return fail(500, { message: 'Could not dismiss the guide. Try again.', guideFailed: true });
    }
  },

  dismissWhatsNew: async ({ locals }) => {
    const status = await requireMember(db, locals.user.id);
    if (!(await dismissWhatsNew(seenStore, locals.user.id, status))) {
      return fail(500);
    }
  },

  dismissProgress: async ({ locals }) => {
    const status = await requireMember(db, locals.user.id);
    if (!(await dismissProgress(seenStore, locals.user.id, status))) {
      return fail(500, {
        message: DISMISS_FAILED,
        progressFailed: true,
      });
    }
  },

  apprentice: async ({ request, locals }) => {
    if ((await getStanding(db, locals.user.id)).muted) return mutedFailure();
    if (!(await consented(locals.user.id))) return consentFailure();
    const form = await request.formData();
    const kind = form.get('kind');
    const referenceId = Number(form.get('referenceId'));
    const answer = form.get('answer');
    const version = form.get('version');
    if (
      (kind !== 'rating' && kind !== 'yesno') ||
      !Number.isInteger(referenceId) ||
      typeof answer !== 'string'
    ) {
      return fail(400, { message: 'Pick an answer.' });
    }

    const onCard = await standingOnCard(form, locals.user.id);
    try {
      const result = await answerApprentice(
        db,
        {
          userId: locals.user.id,
          kind,
          referenceId,
          version: typeof version === 'string' ? version : null,
          answer,
        },
        apprenticeDeps
      );
      if (result.status === 'rejected') {
        return fail(409, { message: APPRENTICE_REJECTION_TEXT[result.reason] });
      }
      if (onCard) await dismissProgress(seenStore, locals.user.id, onCard);
      // Only whether the pick was right: the page plays a sound and shows no verdict.
      return { success: true, correct: result.correct, promoted: result.promoted };
    } catch (error) {
      console.error('knights: apprenticeship answer failed', { referenceId, error });
      return fail(500, { message: 'Your answer could not be recorded. Try again in a moment.' });
    }
  },

  continueCheckpoint: async ({ request, locals }) => {
    const onCard = await standingOnCard(await request.formData(), locals.user.id);
    try {
      await acknowledgeCheckpoint(db, locals.user.id, apprenticeDeps.now());
    } catch (error) {
      console.error('knights: could not move past the checkpoint', { error });
      return fail(500, { message: 'Could not continue. Try again.' });
    }
    if (onCard) await dismissProgress(seenStore, locals.user.id, onCard);
    return { success: true };
  },
};
