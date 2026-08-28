import { getUserNotes } from './moderation-memory.service';
import { getLiveStrikes } from './user-lookup.service';
import { getModActivity, getRetoolActivity } from './user-account.service';
import { getReportsOnUser } from './user-reports.service';
import { DEFAULT_REPORT_REASONS } from '$lib/reports';

// "Has anyone already dealt with this account" — one answer, for every queue that renders
// `AccountHistory`. The caps and the reason filter below are the DEFINITION of that question, not
// per-page tuning: two queues carrying their own copies is how the same account got two different
// histories on two screens.

const STRIKES = 50;
const ACTIVITY = 100;
const REPORTS = 20;

/**
 * Each source is asked for ONE ROW MORE than the panel shows, and the extra row is dropped here.
 *
 * 🔴 That row is the whole of what stops a cap being reported as a total. Every count in this panel is
 * `.length` over an already-capped list, so on an account past the cap the header stated the cap as the
 * answer — and the activity list went further: its "Show all (N more)" hid a number derived from the
 * same truncated array, so expanding it said "Show fewer" with nothing left, on the screen where the
 * next strike is decided. Reporting an enforcement history as complete when it is not is the one wrong
 * answer this panel must never give.
 *
 * A `count()` per source would give an exact total instead of "200+", and is deliberately not done: it
 * is four more queries — one of them the `ReToolActions` seq scan — on a panel that re-renders on every
 * queue row click, to sharpen a number nobody acts on past "there is more". `truncated` is also the
 * spelling `BulkBatch` already uses for this.
 */
const window = <T>(rows: T[], limit: number) => ({
  rows: rows.slice(0, limit),
  truncated: rows.length > limit,
});

export type AccountHistoryData = Awaited<ReturnType<typeof loadAccountHistory>>;

export async function loadAccountHistory(userId: number, viewerUsername: string | null) {
  const [strikes, notes, modActivity, ratingActivity, retoolActivity, reportsOnUser] =
    await Promise.all([
      // The MAIN APP's strikes, not the moderator database's Retool-era table — that one is written by
      // nothing, so this panel read 0 on an account carrying ten live strikes, which is the worst
      // possible number to be wrong about on the screen where the next one is issued.
      getLiveStrikes(userId, { limit: STRIKES + 1 }),
      // Deciding on a strike without the prior note is the thing notes exist to stop, and "it is in
      // User Lookup" is a different screen.
      getUserNotes(userId, viewerUsername),
      // Two buckets, two limited queries — never one query filtered afterwards. See `getModActivity`.
      getModActivity(userId, ACTIVITY + 1, 'enforcement'),
      getModActivity(userId, ACTIVITY + 1, 'rating'),
      // `ModActivity` keys on content and did not exist for the Retool years, so on its own it prints
      // "nothing recorded" for an account carrying a decade of enforcement.
      getRetoolActivity(userId, ACTIVITY + 1),
      // Every status, not the open ones: what is missing from the queue row is whether this account has
      // been reported and RULED ON before.
      //
      // Human-filed only. `Automated` is 99.9% of this table — one dev account carries 556 of them — so
      // an unfiltered list of 20 answers nothing about whether a person has complained.
      getReportsOnUser(userId, {
        limit: REPORTS + 1,
        statuses: [],
        reasons: DEFAULT_REPORT_REASONS,
      }),
    ]);

  const activity = window(modActivity, ACTIVITY);
  const rating = window(ratingActivity, ACTIVITY);
  const retool = window(retoolActivity, ACTIVITY);
  const strikeWindow = window(strikes, STRIKES);
  const reportWindow = window(reportsOnUser, REPORTS);

  return {
    strikes: strikeWindow.rows,
    notes,
    modActivity: activity.rows,
    ratingActivity: rating.rows,
    retoolActivity: retool.rows,
    reportsOnUser: reportWindow.rows,
    truncated: {
      strikes: strikeWindow.truncated,
      // One flag for the merged list the panel renders, since it counts the three together.
      activity: activity.truncated || rating.truncated || retool.truncated,
      reports: reportWindow.truncated,
    },
  };
}
