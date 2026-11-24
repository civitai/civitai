import { fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { requireMember } from '$lib/server/membership';
import { getStanding, mutedFailure } from '$lib/server/standing';
import { playerPrefs, setYesNoQuestions } from '$lib/server/player-prefs';
import { yesNoConfig } from '$lib/server/yesno/runtime';
import type { Actions, PageServerLoad } from './$types';

// Acolytes keep their hand-picked practice questions: they are part of training, so the switch is not theirs to turn off.
const choosesQuestions = (rank: string) => rank !== 'Acolyte';

export const load: PageServerLoad = async ({ locals }) => {
  const status = await requireMember(db, locals.user.id);
  if (!choosesQuestions(status.rank)) return { questions: { available: false as const } };
  const { playerDefault } = await yesNoConfig();
  const prefs = await playerPrefs(db, locals.user.id, playerDefault);
  return { questions: { available: true as const, on: prefs.yesNo } };
};

export const actions: Actions = {
  questions: async ({ locals, request }) => {
    const status = await requireMember(db, locals.user.id);
    if ((await getStanding(db, locals.user.id)).muted) return mutedFailure();
    if (!choosesQuestions(status.rank))
      return fail(403, { message: 'Yes/no questions can be turned off from Knight.' });
    const value = (await request.formData()).get('questions');
    if (value !== 'on' && value !== 'off') return fail(400, { message: 'Choose on or off.' });
    const on = value === 'on';
    await setYesNoQuestions(db, locals.user.id, on, new Date());
    return { questions: on };
  },
};
