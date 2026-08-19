import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { canAccess, requiresGrant } from '$lib/server/access';
import { denied } from '$lib/permissions';
import { parseForm, parseIdList, parseIdListStrict, parseQuery } from '$lib/server/query';
import { BAN_REASON_CODES, setBanned } from '$lib/server/user-actions.service';
import { addUserNote } from '$lib/server/moderation-memory.service';
import {
  getAccountsOnDomains,
  getAccountsOnIps,
  getBanCandidates,
  getEmailDomains,
  getRegistrationIps,
  getTippersTo,
  resolveUsernamesToIds,
} from '$lib/server/bulk-ban.service';

// The pasted list is in the URL so a moderator can hand a colleague the exact set they are about to
// ban, and so the preflight survives a reload.
const querySchema = z.object({
  ids: z.string().trim().catch(''),
  names: z.string().trim().catch(''),
  ips: z.string().trim().catch(''),
  domains: z.string().trim().catch(''),
  // Retool's GetUsers, parameterised. `minAccountId` defaults to its hardcoded 5400000 so the finder
  // opens on "recently created accounts" rather than on every supporter a creator has ever had.
  tippedTo: z.string().trim().catch(''),
  minTip: z.coerce.number().int().min(0).catch(50),
  minAccountId: z.coerce.number().int().min(0).catch(5_400_000),
  tipDays: z.coerce.number().int().min(0).catch(0),
});

const splitList = (value: string) =>
  value
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

export const load: PageServerLoad = async ({ url, locals }) => {
  const {
    ids,
    names,
    ips,
    domains: domainTerms,
    tippedTo,
    minTip,
    minAccountId,
    tipDays,
  } = parseQuery(url, querySchema);

  // Mass banning is the highest-blast-radius action in the app; Retool restricted this app to some
  // mods and the walkthrough treats widening it as a decision, not a default.
  const canAct = !!locals.grants['bulk-ban.execute'];

  const fromNames = names ? await resolveUsernamesToIds(splitList(names)) : [];
  const userIds = [...new Set([...parseIdList(ids.replace(/[\s\n]+/g, ',')), ...fromNames])];

  // Three of these six read ClickHouse, and a `Promise.all` made the whole page 500 when it was
  // unreachable — including the pure-Postgres halves that are the actual ban path. Losing the IP
  // clustering is a degraded investigation; losing the candidate list and the ban button on a page
  // whose job is stopping a ring is an outage. Each ClickHouse source now fails to empty and says so.
  const clickhouseDown: string[] = [];
  const degrade = <T>(label: string, p: Promise<T[]>) =>
    p.catch((e) => {
      console.error(`[bulk-ban] ${label} unavailable`, e);
      clickhouseDown.push(label);
      return [] as T[];
    });

  const [candidates, registrationIps, domains, ipAccounts, domainAccounts, tippers] =
    await Promise.all([
      getBanCandidates(userIds),
      degrade('registration IPs', getRegistrationIps(userIds)),
      getEmailDomains(userIds),
      ips ? degrade('accounts on IPs', getAccountsOnIps(splitList(ips))) : Promise.resolve([]),
      domainTerms ? getAccountsOnDomains(splitList(domainTerms)) : Promise.resolve([]),
      tippedTo
        ? degrade(
            'tippers',
            getTippersTo(parseIdList(tippedTo.replace(/[\s\n]+/g, ',')), {
              minAmount: minTip,
              minAccountId,
              days: tipDays,
            })
          )
        : Promise.resolve([]),
    ]);

  return {
    ids,
    names,
    ips,
    domainTerms,
    domainAccounts,
    tippedTo,
    minTip,
    minAccountId,
    tipDays,
    tippers,
    canAct,
    candidates,
    registrationIps,
    domains,
    ipAccounts,
    clickhouseDown,
    // Ids that matched no account at all — a typo in a pasted list is otherwise invisible.
    unmatched: userIds.filter((id) => !candidates.some((c) => c.id === id)),
    wide: true,
  };
};

const actionFail = (message: string) => fail(400, { error: message });

export const actions: Actions = {
  /**
   * Retool's `BanUsers`: sequential, retrying the SAME id on failure, aborting the whole run after 5
   * consecutive failures. The cap is the safety property — without it a bad token or a downed endpoint
   * retries every account in the list rather than stopping after the first few.
   */
  banAll: requiresGrant('bulk-ban.execute', async ({ request, locals }) => {
    const input = parseForm(
      z.object({
        userIds: z.string(),
        reasonCode: z.enum(BAN_REASON_CODES),
        detailsInternal: z.string().trim().max(500).optional(),
        note: z.string().trim().max(1000).optional(),
        removeMedia: z.coerce.boolean().catch(false),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return actionFail(input);

    const userIds = parseIdListStrict(input.userIds, 1000);
    if (typeof userIds === 'string') return actionFail(userIds);
    if (!userIds.length) return actionFail('No accounts to ban.');

    const banned: number[] = [];
    const failed: number[] = [];
    let consecutiveFailures = 0;

    for (const userId of userIds) {
      let ok = false;
      // Retool retried the same id; one retry is enough to clear a transient blip without turning a
      // systemic failure into a long loop.
      for (let attempt = 0; attempt < 2 && !ok; attempt++) {
        const result = await setBanned({
          userId,
          ban: true,
          reasonCode: input.reasonCode,
          detailsInternal: input.detailsInternal,
          removeMedia: input.removeMedia,
          moderatorId: locals.user.id,
        });
        ok = result.ok;
      }

      if (ok) {
        banned.push(userId);
        consecutiveFailures = 0;
        if (input.note && locals.user.username) {
          await addUserNote({ userId, notes: input.note, author: locals.user.username });
        }
      } else {
        failed.push(userId);
        consecutiveFailures++;
        // Retool's cap. Stop rather than work through the rest of the list against a broken endpoint.
        if (consecutiveFailures >= 5) {
          return fail(400, {
            error: `Stopped after 5 consecutive failures. ${banned.length} banned, ${failed.length} failed; the rest were not attempted.`,
            banned: banned.length,
          });
        }
      }
    }

    return {
      success: true,
      banned: banned.length,
      warning: failed.length
        ? `${failed.length} could not be banned: ${failed.slice(0, 20).join(', ')}`
        : undefined,
    };
  }),

  /**
   * Retool's `button2` ("Add Notes"), which triggered `UserNotes` ALONE — it did not ban. Two things
   * were lost by only writing notes inside the ban loop: annotating a cohort you have identified but
   * not yet decided on, and noting the accounts a ban failed on or that were already banned.
   *
   * Not senior-gated: a note is not an enforcement action, and the page's own `/users` gate already
   * applies. Notes go on EVERY matched candidate, banned or not — that is the point.
   */
  addNotes: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users')) return actionFail('Not permitted.');
    const author = locals.user.username;
    if (!author) return actionFail('Your account has no username to attribute the note to.');

    const input = parseForm(
      z.object({
        userIds: z.string(),
        note: z.string().trim().min(1).max(1000),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return actionFail(input);

    const userIds = parseIdListStrict(input.userIds, 5000);
    if (typeof userIds === 'string') return actionFail(userIds);
    if (!userIds.length) return actionFail('No accounts to annotate.');

    const results = await Promise.all(
      userIds.map((userId) =>
        addUserNote({ userId, notes: input.note, author })
          .then(() => true)
          .catch(() => false)
      )
    );
    const noted = results.filter(Boolean).length;
    if (noted === 0) return actionFail('Could not write any notes.');

    return {
      success: true,
      noted,
      warning:
        noted < userIds.length
          ? `${userIds.length - noted} note(s) could not be written.`
          : undefined,
    };
  },
};
