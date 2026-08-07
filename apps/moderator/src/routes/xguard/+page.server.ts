import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireAccess } from '$lib/server/access';
import { labDb } from '$lib/server/xguard-lab';

// Review queue for the XGuard label lab. One item is one (sample, label) pair the current
// reviewer has not judged yet, shown with whatever the AI rater decided so the reviewer only
// has to agree or disagree.
//
// `?sample=` pins one pair instead of taking the head of the queue, which is how both "undo the
// last one" and a deep link out of an evaluation's FP list arrive here.

// Skips live in the URL, not the database. A skip means "not now", so it has to survive an
// invalidate and still be gone by the next session - a human_judgement row would make it permanent.
const MAX_SKIPS = 100;

// These ids reach a bigint column. Anything non-numeric makes Postgres raise `invalid input syntax
// for type bigint`, which is a 500 on a page whose state lives in a hand-editable URL - so junk is
// dropped rather than surfaced as an error.
function asId(raw: string | null): string | null {
  return raw && /^\d+$/.test(raw) ? raw : null;
}

function parseSkips(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .filter((v) => /^\d+$/.test(v))
    .slice(-MAX_SKIPS);
}

export const load: PageServerLoad = async ({ locals, url }) => {
  requireAccess(locals.user, url.pathname);

  const label = url.searchParams.get('label') ?? 'AgeAsserted';
  const pinnedSampleId = asId(url.searchParams.get('sample'));
  const skipped = parseSkips(url.searchParams.get('skip'));
  const reviewerId = locals.user?.id ?? 0;

  const selection = [
    'm.id as judgementId',
    'm.verdict as aiVerdict',
    'm.reason as aiReason',
    'm.highlights',
    'm.model',
    's.id as sampleId',
    's.positive_prompt as positivePrompt',
    's.negative_prompt as negativePrompt',
    's.live_scores as liveScores',
    's.batch',
  ] as const;

  // Independent queries, so they go out together. Sequential awaits cost a full round trip each,
  // which is invisible against a local lab DB and very much not once this moves to the cluster.
  const labelsQuery = labDb
    .selectFrom('label_def')
    .select(['name', 'description'])
    .orderBy('name')
    .execute();

  let itemQuery = labDb
    .selectFrom('machine_judgement as m')
    .innerJoin('sample as s', 's.id', 'm.sample_id')
    .select([...selection])
    .where('m.label', '=', label)
    .where('m.source', '=', 'ai');

  if (pinnedSampleId) {
    itemQuery = itemQuery.where('m.sample_id', '=', pinnedSampleId);
  } else {
    itemQuery = itemQuery
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('human_judgement as h')
              .select('h.id')
              .whereRef('h.sample_id', '=', 'm.sample_id')
              .where('h.label', '=', label)
              .where('h.reviewer_id', '=', reviewerId)
          )
        )
      )
      // Rater-positives first. Most of a stratified sample is uncontroversially negative, and an
      // evaluation cannot measure recall until some positives have been confirmed - so the queue
      // spends a reviewer's attention where it actually changes a number.
      .orderBy('m.verdict', 'desc')
      .orderBy('m.sample_id');
    if (skipped.length) itemQuery = itemQuery.where('m.sample_id', 'not in', skipped);
  }

  const countsQuery = labDb
    .selectFrom('machine_judgement as m')
    .select(({ fn }) => [fn.countAll<string>().as('rated')])
    .where('m.label', '=', label)
    .where('m.source', '=', 'ai')
    .executeTakeFirst();

  const reviewedQuery = labDb
    .selectFrom('human_judgement')
    .select(({ fn }) => [
      fn.countAll<string>().as('total'),
      fn.count<string>('id').filterWhere('agreed', '=', false).as('disagreed'),
      fn.count<string>('id').filterWhere('verdict', '=', true).as('positives'),
    ])
    .where('label', '=', label)
    .where('reviewer_id', '=', reviewerId)
    .where('excluded_reason', 'is', null)
    .executeTakeFirst();

  // Confirmed positives across every reviewer, because that is what makes recall measurable - one
  // reviewer's own tally does not answer "can this label be evaluated yet".
  const labelPositivesQuery = labDb
    .selectFrom('human_judgement')
    .select(({ fn }) => [fn.count<string>('sample_id').distinct().as('positives')])
    .where('label', '=', label)
    .where('verdict', '=', true)
    .where('excluded_reason', 'is', null)
    .executeTakeFirst();

  const lastReviewedQuery = labDb
    .selectFrom('human_judgement')
    .select(['sample_id as sampleId'])
    .where('label', '=', label)
    .where('reviewer_id', '=', reviewerId)
    .where('excluded_reason', 'is', null)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();

  const existingQuery = pinnedSampleId
    ? labDb
        .selectFrom('human_judgement')
        .select(['agreed', 'verdict', 'note'])
        .where('label', '=', label)
        .where('reviewer_id', '=', reviewerId)
        .where('sample_id', '=', pinnedSampleId)
        .executeTakeFirst()
    : Promise.resolve(undefined);

  const [labels, item, counts, reviewed, labelPositives, lastReviewed, existing] =
    await Promise.all([
      labelsQuery,
      itemQuery.limit(1).executeTakeFirst(),
      countsQuery,
      reviewedQuery,
      labelPositivesQuery,
      lastReviewedQuery,
      existingQuery,
    ]);

  // Highlight vocabulary for this label. Lives in `label_term` rather than a constant so it can be
  // edited per label without a deploy.
  const terms = await labDb
    .selectFrom('label_term')
    .select(['label', 'term', 'kind'])
    .where('label', '=', label)
    .execute();

  // @civitai/db registers a process-global INT8 parser, so bigint ids arrive as JS numbers even
  // though LabDB types them as strings. Normalise here or every `id === param` comparison on the
  // client silently never matches.
  const normalised = item
    ? { ...item, sampleId: String(item.sampleId), judgementId: String(item.judgementId) }
    : null;

  return {
    label,
    labels,
    terms,
    item: normalised,
    pinned: Boolean(pinnedSampleId),
    existing: existing ?? null,
    skipped,
    lastReviewedSampleId: lastReviewed ? String(lastReviewed.sampleId) : null,
    progress: {
      rated: Number(counts?.rated ?? 0),
      reviewed: Number(reviewed?.total ?? 0),
      disagreed: Number(reviewed?.disagreed ?? 0),
      myPositives: Number(reviewed?.positives ?? 0),
      labelPositives: Number(labelPositives?.positives ?? 0),
    },
  };
};

export const actions: Actions = {
  judge: async ({ request, locals, url }) => {
    requireAccess(locals.user, url.pathname);
    const reviewerId = locals.user?.id;
    if (!reviewerId) return fail(401, { message: 'Not signed in' });

    const form = await request.formData();
    const sampleId = asId(String(form.get('sampleId') ?? ''));
    const label = String(form.get('label') ?? '');
    const judgementId = asId(String(form.get('judgementId') ?? ''));
    const agreed = form.get('agreed') === 'true';
    const aiVerdict = form.get('aiVerdict') === 'true';
    const durationMs = Number(form.get('durationMs') ?? 0) || null;
    const note = String(form.get('note') ?? '').trim() || null;

    if (!sampleId || !label) return fail(400, { message: 'Missing sample or label' });

    await labDb
      .insertInto('human_judgement')
      .values({
        sample_id: sampleId,
        label,
        reviewed_judgement_id: judgementId || null,
        agreed,
        // Disagreeing means the opposite of what the rater said. Stored explicitly so the
        // training set reads off one column instead of a join and a conditional.
        verdict: agreed ? aiVerdict : !aiVerdict,
        note,
        reviewer_id: reviewerId,
        duration_ms: durationMs,
      })
      .onConflict((oc) =>
        oc.columns(['sample_id', 'label', 'reviewer_id']).doUpdateSet({
          // Re-reviewing a retired judgement makes it valid again.
          excluded_reason: null,
          agreed,
          verdict: agreed ? aiVerdict : !aiVerdict,
          reviewed_judgement_id: judgementId || null,
          note,
          duration_ms: durationMs,
          // The row holds one current verdict per reviewer, so a re-review replaces the whole
          // record - including when it happened, which is what "go back one" reads to find it.
          created_at: new Date(),
        })
      )
      .execute();

    return { success: true };
  },
};
