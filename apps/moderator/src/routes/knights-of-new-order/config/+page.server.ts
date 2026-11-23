import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { requireAccess } from '$lib/server/access';
import { parseForm } from '$lib/server/query';
import {
  getLastSourcesChange,
  getSourcesContext,
  getSourcesSettings,
  saveGameSettings,
  saveSourcesConfig,
} from '$lib/server/knights/sources-config.service';
import { parseGameForm } from './game-form';
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

// The form posts percentages; the transforms turn them into the stored 0–1 rates.
const sourcesForm = z.object({
  enabled: z.enum(['true', 'false']).transform((value) => value === 'true'),
  sfwPercent: percent('The SFW rate'),
  nsfwPercent: percent('The NSFW rate'),
  // Yes/no questions on (share 1), off (0) or back to Knights' environment default (cleared). Absent keeps what is stored.
  yesNo: z.enum(['on', 'off', 'default']).optional(),
  // A blank or absent box leaves the stored cap as it is; the service checks the range.
  maxOpen: z
    .string()
    .optional()
    .transform((text, ctx) => {
      if (text === undefined || text.trim() === '') return undefined;
      const trimmed = text.trim().replaceAll(',', '');
      if (!/^\d+$/.test(trimmed)) {
        ctx.addIssue({ code: 'custom', message: 'The open-item cap must be a whole number.' });
        return z.NEVER;
      }
      return Number(trimmed);
    }),
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
          ...(input.maxOpen === undefined ? {} : { maxOpen: input.maxOpen }),
          ...(input.yesNo === undefined
            ? {}
            : { yesNoShare: input.yesNo === 'default' ? null : input.yesNo === 'on' ? 1 : 0 }),
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
  game: async ({ request, locals, url }) => {
    requireAccess(locals.user, url.pathname);
    const input = parseGameForm(await request.formData());
    if (!input.ok) return fail(400, { error: input.error });
    try {
      const result = await saveGameSettings(input.changes, locals.user.id, {
        killSwitchesConfirmed: input.confirmed,
      });
      return result.ok
        ? { success: true, changed: result.changed }
        : fail(400, { error: result.error });
    } catch (error) {
      console.error('knights game settings: could not save', { error });
      return fail(500, {
        error: 'The settings could not be saved. Nothing was changed; try again.',
      });
    }
  },
};
