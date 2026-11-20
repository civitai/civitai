import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { isPreservedVerdict } from '$lib/preserved-view';
import {
  deliveredTo,
  openPreservedFilesOrError,
  parseFileNumber,
  preservedVerdicts,
  recordPreservedVerdict,
  requirePreservedReviewer,
} from '$lib/server/preserved-view';

export const load: PageServerLoad = async ({ locals }) => {
  const { config } = requirePreservedReviewer(locals);
  const { files } = await openPreservedFilesOrError(config);
  const verdicts = await preservedVerdicts(files, config.reviewerIds);
  return {
    files: files.map((f) => ({ n: f.n, size: f.size, verdict: verdicts.get(f.n) ?? null })),
  };
};

export const actions: Actions = {
  verdict: async ({ request, locals }) => {
    const { config, reviewerId } = requirePreservedReviewer(locals);
    const form = await request.formData();
    const n = parseFileNumber(String(form.get('n') ?? ''));
    const verdict = form.get('verdict');
    if (!n || !isPreservedVerdict(verdict))
      return fail(400, { n, error: 'Pick a file and a verdict.' });
    const { files } = await openPreservedFilesOrError(config);
    const file = files.find((f) => f.n === n);
    if (!file) return fail(404, { n, error: 'There is no such file.' });
    if (!(await deliveredTo([file], reviewerId)).has(n))
      return fail(409, { n, error: 'Open the file before recording a verdict.' });
    if ((await recordPreservedVerdict(file, reviewerId, config.reviewerIds, verdict)) === 'already')
      return fail(409, { n, error: 'A verdict for this file is already recorded.' });
    return { recorded: n };
  },
};
