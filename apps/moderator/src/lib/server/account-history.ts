import { getUserNotes } from './moderation-memory.service';
import { getLiveStrikes } from './user-lookup.service';
import { getModActivity, getRetoolActivity } from './user-account.service';
import { getReportsOnUser } from './user-reports.service';
import { DEFAULT_REPORT_REASONS } from '$lib/reports';

// "Has anyone already dealt with this account" — one answer, for every queue that renders
// `AccountHistory`. The caps and the reason filter below are the DEFINITION of that question, not
// per-page tuning: two queues carrying their own copies is how the same account got two different
// histories on two screens.

export type AccountHistoryData = Awaited<ReturnType<typeof loadAccountHistory>>;

export async function loadAccountHistory(userId: number, viewerUsername: string | null) {
  const [strikes, notes, modActivity, ratingActivity, retoolActivity, reportsOnUser] =
    await Promise.all([
      // The MAIN APP's strikes, not the moderator database's Retool-era table — that one is written by
      // nothing, so this panel read 0 on an account carrying ten live strikes, which is the worst
      // possible number to be wrong about on the screen where the next one is issued.
      getLiveStrikes(userId),
      // Deciding on a strike without the prior note is the thing notes exist to stop, and "it is in
      // User Lookup" is a different screen.
      getUserNotes(userId, viewerUsername),
      // Two buckets, two limited queries — never one query filtered afterwards. See `getModActivity`.
      getModActivity(userId, 100, 'enforcement'),
      getModActivity(userId, 100, 'rating'),
      // `ModActivity` keys on content and did not exist for the Retool years, so on its own it prints
      // "nothing recorded" for an account carrying a decade of enforcement.
      getRetoolActivity(userId, 100),
      // Every status, not the open ones: what is missing from the queue row is whether this account has
      // been reported and RULED ON before.
      //
      // Human-filed only. `Automated` is 99.9% of this table — one dev account carries 556 of them — so
      // an unfiltered list of 20 answers nothing about whether a person has complained.
      getReportsOnUser(userId, { limit: 20, statuses: [], reasons: DEFAULT_REPORT_REASONS }),
    ]);

  return {
    strikes,
    notes,
    modActivity,
    ratingActivity,
    retoolActivity,
    reportsOnUser,
  };
}
