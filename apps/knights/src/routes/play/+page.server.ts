import { type ActionFailure, fail } from '@sveltejs/kit';
import { isBlockReason } from '$lib/block-reasons';
import { db } from '$lib/server/db';
import { getDailyStatus } from '$lib/server/daily/daily.service';
import { openItem } from '$lib/server/feed-token';
import {
  answerHiddenCheck,
  dismissHiddenNotices,
  readHiddenNotices,
} from '$lib/server/hidden/hidden.service';
import { requireMember } from '$lib/server/membership';
import { getPlayerStatus } from '$lib/server/player-status';
import { isRank, RANK_RULES } from '$lib/server/ranks';
import { getStanding, mutedFailure } from '$lib/server/standing';
import { rankTable } from '$lib/server/progression/rating';
import { ratingGuide } from '$lib/server/rules';
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
import { railFor } from '$lib/server/rail-runtime';
import { castVote, type RejectReason } from '$lib/server/queue/queue.service';
import { queueDeps } from '$lib/server/queue/runtime';
import { lockoutFor, voteGate } from '$lib/server/vote-limits/runtime';
import { feedSecret } from '$lib/server/smites/runtime';
import { dismissResetNotice, hasUnseenReset } from '$lib/server/smites/smites.service';
import { yesNoConfig } from '$lib/server/yesno/runtime';
import { castYesNoVote } from '$lib/server/yesno/vote';
import { apprenticeDeps } from '$lib/server/apprenticeship/runtime';
import { crossedMilestone, previousMilestone } from '$lib/server/apprenticeship/standing';
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
  'not-open': 'This one has already been settled.',
  unavailable: 'This one is not open for judging.',
  'no-weight': 'Your standing is too low for your judgment to count yet.',
  'reset-pending': 'Your career is being reset. Return in a moment.',
};

const APPRENTICE_REJECTION_TEXT = {
  'no-player': 'You have not joined the Order yet.',
  'not-acolyte': 'Your apprenticeship is over.',
  'checkpoint-pending': 'Take a look at your recap first.',
  'not-current': 'That is not the image before you now.',
  'bad-answer': 'That answer is not on offer.',
} as const;

type Perks = { goldMultiplier: number; dailyGoldCap: number };
type RankPerks = {
  levels?: string;
  goldMultiplier?: number;
  dailyGoldCap?: number;
  /** The perks of the rank the player held before, for the rank-up's "what changed". */
  previous?: Perks;
};
type Notice = ProgressNotice &
  RankPerks & { milestone?: string; milestoneLevel?: number; levelGold?: number };

const perksOf = (rank: string): Perks | undefined =>
  isRank(rank)
    ? {
        goldMultiplier: RANK_RULES[rank].goldMultiplier,
        dailyGoldCap: RANK_RULES[rank].dailyGoldCap,
      }
    : undefined;

// A rank-up notice says what the rank brings and what it replaces; a level-up carries nothing more.
function withRankPerks(progress: ProgressNotice | null): Notice | null {
  if (progress?.kind !== 'rank') return progress;
  const perks = rankTable().find((entry) => entry.rank === progress.rank);
  if (!perks) return progress;
  return {
    ...progress,
    levels: perks.levels,
    goldMultiplier: perks.goldMultiplier,
    dailyGoldCap: perks.dailyGoldCap,
    previous: perksOf(progress.fromRank),
  };
}

// An Acolyte levels up every few answers, so only the milestone levels are celebrated; every other level is recorded as seen.
async function acolyteMilestone(
  progress: Notice | null,
  status: { rank: string; level: number },
  userId: number
): Promise<Notice | null> {
  if (progress?.kind !== 'level') return progress;
  const milestone = crossedMilestone(progress.from, progress.level);
  if (milestone) {
    // The card celebrates this milestone: its gold is the levels since the one before it (not since the level last seen,
    // which a quiet load moves up every level), and stops here, so it does not grow with the levels the player reaches while the card is open.
    const levelGold = await acolyteLevelGoldSince(
      db,
      userId,
      previousMilestone(milestone.level),
      milestone.level
    );
    return { ...progress, milestone: milestone.copy, milestoneLevel: milestone.level, levelGold };
  }
  await dismissProgress(seenStore, userId, status);
  return null;
}

export const load: PageServerLoad = async ({ locals, depends }) => {
  depends('app:play');
  const [status, { muted }] = await Promise.all([
    requireMember(db, locals.user.id),
    getStanding(db, locals.user.id),
  ]);
  const now = queueDeps.now();
  const [resetNotice, notices, seen] = await Promise.all([
    hasUnseenReset(db, locals.user.id, now),
    readHiddenNotices(db, locals.user.id),
    readNotices(seenStore, locals.user.id, status),
  ]);
  const common = {
    status,
    muted,
    resetNotice,
    notices,
    whatsNew: seen.whatsNew ? whatsNewCopy(isReturningPlayer(status)) : null,
    showGuide: seen.guide,
    progress: withRankPerks(seen.progress),
    ratingGuide: ratingGuide(),
  };

  if (status.rank === 'Acolyte' && !muted) {
    const view = await getApprentice(db, locals.user.id);
    if (view.kind !== 'not-acolyte') {
      return {
        mode: 'apprentice' as const,
        ...common,
        progress: await acolyteMilestone(common.progress, status, locals.user.id),
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
    getDailyStatus(db, { playerId: locals.user.id, rank: status.rank, now }),
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

const limitedFailure = (until: Date) =>
  fail(429, {
    message: 'You are judging too quickly. Rest a little.',
    lockoutSeconds: Math.max(1, Math.ceil((until.getTime() - queueDeps.now().getTime()) / 1000)),
  });

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
}: VoteEvent): Promise<{ failure: ActionFailure<{ message: string }> } | ParsedVote> {
  const form = await request.formData();
  const token = form.get('item');
  const answer = form.get('answer');
  const reasonField = form.get('blockReason');
  if (typeof token !== 'string' || typeof answer !== 'string') {
    return { failure: fail(400, { message: 'Pick an answer.' }) };
  }
  if (reasonField !== null && typeof reasonField !== 'string') {
    return { failure: fail(400, { message: BLOCK_REASON_TEXT }) };
  }
  const blockReason = reasonField === '' ? null : reasonField;
  if (blockReason !== null && !isBlockReason(blockReason)) {
    return { failure: fail(400, { message: BLOCK_REASON_TEXT }) };
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
  if (!ref) return { failure: fail(400, { message: 'Pick an answer.' }) };
  const itemId = ref.id;
  if (ref.kind === 'yesno' && blockReason !== null) {
    return { failure: fail(400, { message: BLOCK_REASON_TEXT }) };
  }
  return { ref, answer, blockReason, itemId };
}

async function recordVote({ ref, answer, blockReason, itemId }: ParsedVote, { locals }: VoteEvent) {
  try {
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
            queueDeps
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
    if (result.status === 'limited') return limitedFailure(result.until);
    if (result.status === 'rejected') {
      return fail(result.reason === 'bad-block-reason' ? 400 : 409, {
        message: REJECTION_TEXT[result.reason],
      });
    }
    return { success: true };
  } catch (error) {
    console.error('knights: vote failed', { itemId, error });
    return fail(500, { message: 'Your judgment could not be recorded. Try again in a moment.' });
  }
}

export const actions: Actions = {
  // Every kind of vote (rating, yes/no, hidden check) passes the Redis vote limits here, before any database work.
  vote: async (event) => {
    if ((await getStanding(db, event.locals.user.id)).muted) return mutedFailure();
    const parsed = await readVote(event);
    if ('failure' in parsed) return parsed.failure;
    const outcome = await voteGate.guard(
      event.locals.user.id,
      queueDeps.now(),
      () => recordVote(parsed, event),
      { moderator: event.locals.user.isModerator }
    );
    if (!('until' in outcome)) return outcome;
    return outcome.busy ? busyFailure() : limitedFailure(outcome.until);
  },

  // Moves a player past an item without judging it: no vote, pay, accuracy or Watch credit, and it is not served to them
  // again. Every kind of item is handled and answered alike, so a skip does not show what the item was.
  skip: async ({ request, locals }) => {
    if ((await getStanding(db, locals.user.id)).muted) return mutedFailure();
    const token = (await request.formData()).get('item');
    let ref: ReturnType<typeof openItem> = null;
    try {
      if (typeof token === 'string') ref = openItem(feedSecret(), locals.user.id, token);
    } catch (error) {
      console.error('knights: the feed cannot be served', { error });
    }
    if (!ref) return fail(400, { message: 'That one cannot be skipped.' });
    await recordSkip(skipStore, locals.user.id, ref, queueDeps.now());
    return { success: true };
  },

  dismissNotices: async ({ locals }) => {
    try {
      await dismissHiddenNotices(db, locals.user.id, queueDeps.now());
    } catch (error) {
      console.error('knights: could not store the notice dismissal', { error });
      return fail(500, { message: 'Could not dismiss the notice. Try again.', noticeFailed: true });
    }
  },

  dismissResetNotice: async ({ locals }) => {
    try {
      await dismissResetNotice(db, locals.user.id, queueDeps.now());
    } catch (error) {
      console.error('knights: could not store the reset notice dismissal', { error });
      return fail(500, {
        message: 'Could not dismiss the notice. Try again.',
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
      return fail(500, { message: 'Could not close this. Try again.', whatsNewFailed: true });
    }
  },

  dismissProgress: async ({ locals }) => {
    const status = await requireMember(db, locals.user.id);
    if (!(await dismissProgress(seenStore, locals.user.id, status))) {
      return fail(500, {
        message: 'Could not dismiss the notice. Try again.',
        progressFailed: true,
      });
    }
  },

  apprentice: async ({ request, locals }) => {
    if ((await getStanding(db, locals.user.id)).muted) return mutedFailure();
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
