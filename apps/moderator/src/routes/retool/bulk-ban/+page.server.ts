import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { canAccess, isSenior } from '$lib/server/access';
import { parseForm, parseIdList, parseQuery } from '$lib/server/query';
import { BAN_REASON_CODES, setBanned } from '$lib/server/user-actions.service';
import { addUserNote } from '$lib/server/moderation-memory.service';
import {
  getAccountsOnIps,
  getBanCandidates,
  getEmailDomains,
  getRegistrationIps,
  resolveUsernamesToIds,
} from '$lib/server/bulk-ban.service';

// The pasted list is in the URL so a moderator can hand a colleague the exact set they are about to
// ban, and so the preflight survives a reload.
const querySchema = z.object({
  ids: z.string().trim().catch(''),
  names: z.string().trim().catch(''),
  ips: z.string().trim().catch(''),
});

const splitList = (value: string) =>
  value
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

export const load: PageServerLoad = async ({ url, locals }) => {
  const { ids, names, ips } = parseQuery(url, querySchema);

  // Mass banning is the highest-blast-radius action in the app; Retool restricted this app to some
  // mods and the walkthrough treats widening it as a decision, not a default.
  const canAct = isSenior(locals.user) && canAccess(locals.user, '/users');

  const fromNames = names ? await resolveUsernamesToIds(splitList(names)) : [];
  const userIds = [...new Set([...parseIdList(ids.replace(/[\s\n]+/g, ',')), ...fromNames])];

  const [candidates, registrationIps, domains, ipAccounts] = await Promise.all([
    getBanCandidates(userIds),
    getRegistrationIps(userIds),
    getEmailDomains(userIds),
    ips ? getAccountsOnIps(splitList(ips)) : Promise.resolve([]),
  ]);

  return {
    ids,
    names,
    ips,
    canAct,
    candidates,
    registrationIps,
    domains,
    ipAccounts,
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
  banAll: async ({ request, locals }) => {
    if (!isSenior(locals.user) || !canAccess(locals.user, '/users'))
      return actionFail('Mass banning requires a senior moderator.');

    const input = parseForm(
      z.object({
        userIds: z.string().transform((s) => parseIdList(s, 1001)),
        reasonCode: z.enum(BAN_REASON_CODES),
        detailsInternal: z.string().trim().max(500).optional(),
        note: z.string().trim().max(1000).optional(),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return actionFail(input);
    if (!input.userIds.length) return actionFail('No accounts to ban.');

    const banned: number[] = [];
    const failed: number[] = [];
    let consecutiveFailures = 0;

    for (const userId of input.userIds) {
      let ok = false;
      // Retool retried the same id; one retry is enough to clear a transient blip without turning a
      // systemic failure into a long loop.
      for (let attempt = 0; attempt < 2 && !ok; attempt++) {
        const result = await setBanned({
          userId,
          ban: true,
          reasonCode: input.reasonCode,
          detailsInternal: input.detailsInternal,
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
  },

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
        userIds: z.string().transform((s) => parseIdList(s, 5001)),
        note: z.string().trim().min(1).max(1000),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return actionFail(input);
    if (!input.userIds.length) return actionFail('No accounts to annotate.');

    const results = await Promise.all(
      input.userIds.map((userId) =>
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
        noted < input.userIds.length
          ? `${input.userIds.length - noted} note(s) could not be written.`
          : undefined,
    };
  },
};
