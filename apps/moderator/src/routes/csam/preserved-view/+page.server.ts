import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { isPreservedVerdict } from '$lib/preserved-view';
import {
  ManifestRefusedError,
  openPreservedFiles,
  parseFileNumber,
  preservedVerdicts,
  recordPreservedVerdict,
  requirePreservedReviewer,
  servedTo,
  type PreservedViewConfig,
} from '$lib/server/preserved-view';

async function filesOf(config: PreservedViewConfig) {
  try {
    return (await openPreservedFiles(config)).files;
  } catch (e) {
    if (e instanceof ManifestRefusedError) {
      console.error('[preserved-view] manifest refused', e.reason);
      error(409, 'The manifest does not match its pin.');
    }
    console.error('[preserved-view] manifest read failed', e);
    error(502, 'Could not reach storage.');
  }
}

export const load: PageServerLoad = async ({ locals }) => {
  const { config, reviewerId } = requirePreservedReviewer(locals);
  const [files, verdicts, viewed] = await Promise.all([
    filesOf(config),
    preservedVerdicts(),
    servedTo(reviewerId),
  ]);
  return {
    files: files.map((f) => ({
      n: f.n,
      size: f.size,
      verdict: verdicts.get(f.n) ?? null,
      viewed: viewed.has(f.n),
    })),
  };
};

export const actions: Actions = {
  verdict: async ({ request, locals }) => {
    const { config, reviewerId } = requirePreservedReviewer(locals);
    const form = await request.formData();
    const n = parseFileNumber(String(form.get('n') ?? ''));
    const verdict = form.get('verdict');
    if (!n || !isPreservedVerdict(verdict))
      return fail(400, { error: 'Pick a file and a verdict.' });
    if (!(await filesOf(config)).some((f) => f.n === n))
      return fail(404, { error: 'There is no such file.' });
    if (!(await servedTo(reviewerId)).has(n))
      return fail(409, { error: 'Open the file before recording a verdict.' });
    if ((await recordPreservedVerdict(reviewerId, n, verdict)) === 'already')
      return fail(409, { error: 'A verdict for this file is already recorded.' });
    return { recorded: n };
  },
};
