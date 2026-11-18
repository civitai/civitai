import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { requireAccess } from '$lib/server/access';
import { parseForm } from '$lib/server/query';
import {
  getLastSourcesChange,
  getSourcesContext,
  getSourcesSettings,
  saveSourcesConfig,
} from '$lib/server/knights/sources-config.service';
import { percentToRate } from './rates';

const percent = (label: string) =>
  z.string().transform((text, ctx) => {
    const rate = percentToRate(text);
    if (rate === null) {
      ctx.addIssue({ code: 'custom', message: `${label} must be 0 to 100, up to two decimals.` });
      return z.NEVER;
    }
    return rate;
  });

// A blank box leaves the stored share as it is (undefined is not sent to the service).
const optionalPercent = (label: string) =>
  z
    .string()
    .optional()
    .transform((text, ctx) => {
      if (text === undefined || text.trim() === '') return undefined;
      const rate = percentToRate(text);
      if (rate === null) {
        ctx.addIssue({ code: 'custom', message: `${label} must be 0 to 100, up to two decimals.` });
        return z.NEVER;
      }
      return rate;
    });

// The form posts percentages; the transforms turn them into the stored 0–1 rates.
const sourcesForm = z.object({
  enabled: z.enum(['true', 'false']).transform((value) => value === 'true'),
  sfwPercent: percent('The SFW rate'),
  nsfwPercent: percent('The NSFW rate'),
  yesNoPercent: optionalPercent('The yes/no share'),
  // Ticked: clear the stored share, so Knights uses its environment default; it wins over the box.
  yesNoDefault: z.enum(['true']).optional(),
});

export const load: PageServerLoad = async ({ url, locals }) => {
  requireAccess(locals.user, url.pathname);
  const [settings, lastChange, context] = await Promise.all([
    getSourcesSettings(),
    getLastSourcesChange(),
    getSourcesContext(),
  ]);
  return { settings, lastChange, context };
};

export const actions: Actions = {
  save: async ({ request, locals, url }) => {
    requireAccess(locals.user, url.pathname);
    const input = parseForm(sourcesForm, await request.formData());
    if (typeof input === 'string') return fail(400, { error: input });
    try {
      const result = await saveSourcesConfig(
        {
          enabled: input.enabled,
          sfwRate: input.sfwPercent,
          nsfwRate: input.nsfwPercent,
          ...(input.yesNoDefault
            ? { yesNoShare: null }
            : input.yesNoPercent === undefined
            ? {}
            : { yesNoShare: input.yesNoPercent }),
        },
        locals.user.id
      );
      return result.ok
        ? { success: true, changed: result.changed }
        : fail(400, { error: result.error });
    } catch (error) {
      console.error('knights sources: could not save the config', { error });
      return fail(500, { error: 'The config could not be saved. Nothing was changed; try again.' });
    }
  },
};
