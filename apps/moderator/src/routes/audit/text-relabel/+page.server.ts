import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireAccess } from '$lib/server/access';
import { getModeratorDb } from '$lib/server/moderator-db';
import {
  labelerProgress,
  lastAnsweredToken,
  nextItem,
  ownAnswer,
  ownHandOffs,
  saveAnswer,
} from '$lib/server/text-relabel.service';
import { MAX_NOTE_LENGTH, needsHandOff, parseTextLabel } from '$lib/automated-text/labels';

// Blind relabel of Clavata "Automated" text hits. The labeler sees the text, the one tag it is
// judged against and the kind of content, nothing else, until they call a hand-off tag a clear
// violation; then the report, the content and the author are linked so the case is not a dead end.

const MAX_SKIPS = 100;

// Tokens reach a uuid column, and the URL is hand-editable: junk is dropped, not a 500.
const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asToken(raw: string | null): string | null {
  return raw && TOKEN.test(raw) ? raw : null;
}

function parseSkips(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .filter((v) => TOKEN.test(v))
    .slice(-MAX_SKIPS);
}

export const load: PageServerLoad = async ({ locals, url }) => {
  requireAccess(locals.user, url.pathname);
  if (!locals.user) error(401, 'Not signed in');
  const labelerId = locals.user.id;
  const db = getModeratorDb();
  const pinnedToken = asToken(url.searchParams.get('item'));
  const skipped = parseSkips(url.searchParams.get('skip'));

  const [pinned, progress, lastToken, handOffs] = await Promise.all([
    pinnedToken ? ownAnswer(db, labelerId, pinnedToken) : Promise.resolve(null),
    labelerProgress(db, labelerId),
    lastAnsweredToken(db, labelerId),
    ownHandOffs(db, labelerId),
  ]);
  const item = pinned ?? (await nextItem(db, labelerId, skipped));

  return {
    item: item && {
      token: item.token,
      tag: item.tag,
      text: item.text,
      entityLabel: item.entityLabel,
    },
    existing: pinned ? { label: pinned.label, note: pinned.note } : null,
    pinned: Boolean(pinned),
    pinnedGone: Boolean(pinnedToken && !pinned),
    skipped,
    lastToken,
    progress,
    handOffs,
  };
};

export const actions: Actions = {
  answer: async ({ request, locals, url }) => {
    requireAccess(locals.user, url.pathname);
    const labelerId = locals.user?.id;
    if (!labelerId) return fail(401, { error: 'Not signed in', token: null });

    const form = await request.formData();
    const token = asToken(String(form.get('token') ?? ''));
    if (!token) return fail(400, { error: 'Missing item', token: null });

    const label = parseTextLabel(form.get('label'));
    if (!label) return fail(400, { error: 'Pick one answer', token });

    const note = String(form.get('note') ?? '').trim();
    if (note.length > MAX_NOTE_LENGTH)
      return fail(400, { error: `Keep the note under ${MAX_NOTE_LENGTH} characters`, token });

    const durationMs = Number(form.get('durationMs')) || null;
    const result = await saveAnswer(getModeratorDb(), {
      labelerId,
      token,
      label,
      note: note || null,
      durationMs,
    });
    if (!result.ok)
      return fail(result.reason === 'full' ? 409 : 404, {
        error:
          result.reason === 'full'
            ? 'Two other moderators already labelled that text, so your answer was not saved.'
            : 'That item no longer exists, so your answer was not saved.',
        token,
      });
    return { success: true, handOff: needsHandOff(result.tag, label) ? token : null };
  },
};
