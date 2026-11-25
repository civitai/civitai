import { fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { requireMember } from '$lib/server/membership';
import { getStanding, mutedFailure } from '$lib/server/standing';
import {
  hiddenTagGroups,
  playerPrefs,
  setTagGroupHidden,
  setYesNoQuestions,
} from '$lib/server/player-prefs';
import { isKnightsTagGroupKey, KNIGHTS_TAG_GROUPS } from '@civitai/shared/knights-tag-groups';
import { yesNoConfig } from '$lib/server/yesno/runtime';
import { tunesServing } from '$lib/server/ranks';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
  const status = await requireMember(db, locals.user.id);
  if (!tunesServing(status.rank))
    return {
      questions: { available: false as const },
      tagGroups: { available: false as const },
    };
  const { playerDefault } = await yesNoConfig();
  const [prefs, hidden] = await Promise.all([
    playerPrefs(db, locals.user.id, playerDefault),
    hiddenTagGroups(db, locals.user.id),
  ]);
  return {
    questions: { available: true as const, on: prefs.yesNo },
    tagGroups: {
      available: true as const,
      groups: KNIGHTS_TAG_GROUPS.map((group) => ({
        key: group.key,
        label: group.label,
        hidden: hidden.includes(group.key),
      })),
    },
  };
};

export const actions: Actions = {
  questions: async ({ locals, request }) => {
    const status = await requireMember(db, locals.user.id);
    if ((await getStanding(db, locals.user.id)).muted) return mutedFailure();
    if (!tunesServing(status.rank))
      return fail(403, { message: 'Yes/no questions can be turned off from Knight.' });
    const value = (await request.formData()).get('questions');
    if (value !== 'on' && value !== 'off') return fail(400, { message: 'Choose on or off.' });
    const on = value === 'on';
    await setYesNoQuestions(db, locals.user.id, on, new Date());
    return { questions: on };
  },
  tagGroup: async ({ locals, request }) => {
    const status = await requireMember(db, locals.user.id);
    if ((await getStanding(db, locals.user.id)).muted) return mutedFailure();
    if (!tunesServing(status.rank))
      return fail(403, { message: 'Content groups can be hidden from Knight.' });
    const form = await request.formData();
    const key = form.get('key');
    const value = form.get('hidden');
    if (typeof key !== 'string' || !isKnightsTagGroupKey(key))
      return fail(400, { message: 'Choose one of the groups.' });
    if (value !== 'on' && value !== 'off') return fail(400, { message: 'Choose on or off.' });
    const hidden = value === 'on';
    await setTagGroupHidden(db, locals.user.id, key, hidden, new Date());
    return { tagGroup: key, hidden };
  },
};
