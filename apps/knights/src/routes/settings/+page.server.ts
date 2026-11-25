import { fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { requireMemberRank } from '$lib/server/membership';
import { mutedFailure } from '$lib/server/standing';
import { requestStanding, requireRequestMember } from '$lib/server/request-reads';
import {
  hiddenTagGroups,
  playerPrefs,
  setTagGroupHidden,
  setYesNoQuestions,
} from '$lib/server/player-prefs';
import { isKnightsTagGroupKey, KNIGHTS_TAG_GROUPS } from '$lib/server/knights-tag-groups';
import { yesNoConfig } from '$lib/server/yesno/runtime';
import { tunesServing } from '$lib/server/ranks';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
  const [status, player] = await Promise.all([
    requireRequestMember(db, locals),
    db
      .selectFrom('NewOrderPlayer')
      .select('startAt')
      .where('userId', '=', locals.user.id)
      .executeTakeFirst(),
  ]);
  // Every player can start over, Acolytes included; the restart itself is `RestartCareerDialog` (GET/POST /career).
  const career = { swornIn: player?.startAt.toISOString() ?? null };
  if (!tunesServing(status.rank))
    return {
      questions: { available: false as const },
      tagGroups: { available: false as const },
      career,
    };
  const { playerDefault, share, tagReview } = await yesNoConfig();
  const [prefs, hidden] = await Promise.all([
    playerPrefs(db, locals.user.id, playerDefault),
    hiddenTagGroups(db, locals.user.id),
  ]);
  // With both question sources off on the Config page nothing is served, so the switch would do nothing: the section goes,
  // and the player's stored choice stays for when questions come back.
  const questionsServed = share > 0 || tagReview;
  return {
    questions: questionsServed ? { available: true as const, on: prefs.yesNo } : null,
    tagGroups: {
      available: true as const,
      groups: KNIGHTS_TAG_GROUPS.map((group) => ({
        key: group.key,
        label: group.label,
        description: group.description,
        hidden: hidden.includes(group.key),
      })),
    },
    career,
  };
};

export const actions: Actions = {
  questions: async ({ locals, request }) => {
    const rank = await requireMemberRank(db, locals.user.id);
    if ((await requestStanding(db, locals)).muted) return mutedFailure();
    if (!tunesServing(rank))
      return fail(403, { message: 'Yes/no questions can be turned off from Knight.' });
    const value = (await request.formData()).get('questions');
    if (value !== 'on' && value !== 'off') return fail(400, { message: 'Choose on or off.' });
    const on = value === 'on';
    await setYesNoQuestions(db, locals.user.id, on, new Date());
    return { questions: on };
  },
  tagGroup: async ({ locals, request }) => {
    const rank = await requireMemberRank(db, locals.user.id);
    if ((await requestStanding(db, locals)).muted) return mutedFailure();
    if (!tunesServing(rank))
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
