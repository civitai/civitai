import { z } from 'zod';
import { parseQueryKeys } from '$lib/server/query';
import { getSuspectImages } from '$lib/server/report-triage.service';
import { reportModerationActions } from '$lib/server/report-actions';
import { accountEnforcementActions } from '$lib/server/account-actions';
import { getTimedMute } from '$lib/server/user-actions.service';
import { loadItemReports } from '$lib/server/report-queue-load';
import { ReportEntity, reportPath } from '$lib/reports';
import { lastModActivity } from '$lib/server/mod-activity';
import { ingestionErrorLevelSet } from '@civitai/shared';
import { loadAccountHistory } from '$lib/server/account-history';
import { getReportedAccountDetails } from '$lib/server/user-lookup.service';
import { getReportedAccountModels } from '$lib/server/reported-account.service';
import type { SuspectTab } from './tabs';

// The open account's half of the page. The queue is the layout's (`+layout.server.ts`) and does not
// rerun when the account or its tab changes; this half reruns on nothing else. Shared by the bare
// `/reports/user`, which opens the queue's first account, and `/reports/user/[userId]/[[tab]]`.

const boolParam = z
  .string()
  .optional()
  .transform((v) => v === '1');

// The IMAGE grid's date bounds, which are this page's alone — the queue's live in
// `report-queue-filters.ts`. Kept apart because the semantics differ: `to` here is INCLUSIVE, so a
// date-only value has to reach the end of the day picked rather than midnight at its start.
const imageDateParam = z
  .string()
  .optional()
  .transform((v) => {
    const d = v ? new Date(v) : null;
    return d && !Number.isNaN(d.getTime()) ? d : null;
  });
const endOfDayParam = imageDateParam.transform((d) =>
  d ? new Date(d.getTime() + (d.getTime() % 86_400_000 === 0 ? 86_399_999 : 0)) : null
);

const accountQuerySchema = z.object({
  imgPage: z.coerce.number().int().positive().max(10_000).catch(1),
  tos: boolParam,
  noPrompt: boolParam,
  // Absent means every rating. 0 is allowed on purpose — an unrated image has no browsing level —
  // which is why the absent case is guarded before the split: `''.split(',')` maps to `[0]`, and
  // that filters to unrated-only rather than to everything.
  levels: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(',')
            .map(Number)
            .filter((n) => n === 0 || ingestionErrorLevelSet.has(n))
        : []
    ),
  from: imageDateParam,
  to: endOfDayParam,
  prompt: z.string().trim().max(200).catch(''),
  negativePrompt: z.string().trim().max(200).catch(''),
});

export async function loadAccount(user: number, tab: SuspectTab, url: URL, locals: App.Locals) {
  // Its own keys only: paging or filtering the queue must not refetch the account beside it.
  const { imgPage, tos, noPrompt, levels, from, to, prompt, negativePrompt } = parseQueryKeys(
    url,
    accountQuerySchema
  );
  const filters = { tosOnly: tos, noPrompt, levels, from, to, prompt, negativePrompt };

  // Each tab loads only its own data. The image grid and the account history are the two heavy reads,
  // and a moderator settling a spam report from the profile never opens either.
  const [details, suspect, models, accountHistory, timedMute, reports] = await Promise.all([
    getReportedAccountDetails(user),
    tab === 'images' ? getSuspectImages(user, filters, { page: imgPage }) : null,
    tab === 'models' ? getReportedAccountModels(user) : null,
    // Retool's top-left was three tabs — ModActivity / Reports / UserReport History — and the whole
    // point of this screen is not leaving it.
    tab === 'activity' ? loadAccountHistory(user, locals.user.username ?? null) : null,
    // One row, so the Mute row can say when a timed mute lifts rather than just "muted".
    getTimedMute(user),
    // All of its open reports, not the queue page's: a second one on another page went unruled.
    loadItemReports(ReportEntity.User, user),
  ]);

  // Who banned it — the first question a ban raises, and the card carries only when and why.
  const lastBan = details?.card?.identity?.bannedAt
    ? await lastModActivity('user', user, 'ban')
    : null;

  return {
    suspectId: user,
    bannedBy: lastBan?.moderator ?? null,
    tab,
    details,
    suspect,
    models,
    filters: {
      tos,
      noPrompt,
      levels,
      from: from ? from.toISOString().slice(0, 10) : '',
      to: to ? to.toISOString().slice(0, 10) : '',
      prompt,
      negativePrompt,
    },
    accountHistory,
    timedMute,
    reports,
  };
}

export type AccountData = Awaited<ReturnType<typeof loadAccount>>;

// Both pages that render an account take the same forms.
export const accountActions = {
  ...reportModerationActions(reportPath(ReportEntity.User)),
  ...accountEnforcementActions,
};
