import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { isSuper, requiresGrant } from '$lib/server/access';
import { checkboxField, parseForm, parseIdPaste } from '$lib/server/query';
import {
  abandonInFlight,
  inFlightRuns,
  recentOwnRuns,
  resetBreaker,
  trippedRuns,
} from '$lib/server/scan-probe/runs';
import {
  probeDb,
  runProbe,
  scanningEnabled,
  type RunProbeResult,
} from '$lib/server/scan-probe/service';
import { NOT_AVAILABLE, SCAN_PROBE_LIMITS } from '$lib/scan-probe';

export const load: PageServerLoad = async ({ locals }) => {
  const db = probeDb();
  const [runs, tripped, inFlight] = await Promise.all([
    recentOwnRuns(db, locals.user.id),
    trippedRuns(db),
    inFlightRuns(db),
  ]).catch((e) => {
    console.error('[scan-probe] load failed', e);
    return [null, null, null] as const;
  });
  const admin = isSuper(locals.user);
  return {
    runs,
    stopped: tripped === null ? null : tripped.length > 0,
    // Which images tripped it says which images a scan blocked: admins only.
    tripped: admin ? tripped : null,
    inFlight: admin ? inFlight : null,
    canReset: admin,
    enabled: scanningEnabled(),
    limits: SCAN_PROBE_LIMITS,
  };
};

const runSchema = z.object({
  ids: z.string().max(2000),
  understood: checkboxField.refine(
    Boolean,
    'Confirm that you understand a hit acts on the real image.'
  ),
});

const runIdsSchema = z.object({
  runIds: z
    .string()
    .transform((v) => v.split(',').filter((id) => /^[1-9][0-9]{0,18}$/.test(id)))
    .refine((ids) => ids.length > 0, 'No runs named.'),
});

const DISABLED = 'Scanning is turned off.';

const REFUSAL: Record<Exclude<RunProbeResult, { ok: true }>['reason'], string> = {
  disabled: DISABLED,
  'nothing-eligible': NOT_AVAILABLE,
  breaker: 'The probe is stopped after a blocked or failed scan. An admin must reset it first.',
  'in-flight': 'An earlier probe batch has not finished. Try again once its results are in.',
  'moderator-hourly': `You can probe at most ${SCAN_PROBE_LIMITS.perModeratorPerHour} images an hour. Nothing was submitted.`,
  'global-daily': `The probe's daily limit of ${SCAN_PROBE_LIMITS.globalPerDay} images is reached. Nothing was submitted.`,
  'wrong-account':
    'A scan came back under an account other than the site system account. The probe is stopped; tell an admin.',
};

export const actions: Actions = {
  run: requiresGrant('image.scanProbe.run', async ({ request, locals }) => {
    if (!scanningEnabled()) return fail(409, { error: DISABLED });
    const input = parseForm(runSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { error: input });
    const ids = parseIdPaste(input.ids, SCAN_PROBE_LIMITS.perRun);
    if (typeof ids === 'string') return fail(400, { error: ids });

    const result = await runProbe(locals.user.id, ids).catch((e) => {
      console.error('[scan-probe] run failed', e);
      return null;
    });
    if (!result)
      return fail(500, {
        error: 'The probe hit an error partway. Check your runs below before trying again.',
      });
    if (!result.ok)
      return fail(result.reason === 'nothing-eligible' ? 400 : 409, {
        error: REFUSAL[result.reason],
        refused: result.refused,
      });
    return {
      submitted: result.submitted,
      failed: result.failed,
      stopped: result.stopped,
      refused: result.refused,
    };
  }),

  resetBreaker: async ({ request, locals }) => {
    if (!isSuper(locals.user)) return fail(403, { error: 'Only an admin can reset the probe.' });
    const input = parseForm(runIdsSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { error: input });
    const reset = await resetBreaker(probeDb(), locals.user.id, input.runIds);
    if (!reset) return fail(409, { error: 'Those runs were already reset. Reload.' });
    return { reset };
  },

  abandonInFlight: async ({ request, locals }) => {
    if (!isSuper(locals.user)) return fail(403, { error: 'Only an admin can abandon runs.' });
    const input = parseForm(runIdsSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { error: input });
    const abandoned = await abandonInFlight(probeDb(), locals.user.id, input.runIds);
    if (!abandoned) return fail(409, { error: 'Those runs already finished. Reload.' });
    return { abandoned };
  },
};
