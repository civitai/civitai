import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad, RequestEvent } from './$types';
import { requiresGrant } from '$lib/server/access';
import {
  CSAM_CONTENTS,
  CSAM_CONTENT_KEYS,
  getTrainingVersionDetail,
  moderateTrainingData,
  reportTrainingDataCsam,
} from '$lib/server/training-moderation.service';

const idSchema = z.coerce.number().int().positive().max(2_147_483_647);

export const load: PageServerLoad = async ({ params }) => {
  const versionId = idSchema.safeParse(params.versionId);
  if (!versionId.success) error(400, 'Bad version id.');

  const detail = await getTrainingVersionDetail(versionId.data);
  if (!detail) error(404, 'Model version not found.');

  return { detail, csamContents: CSAM_CONTENTS };
};

const rule = async (event: RequestEvent, approve: boolean) => {
  const versionId = idSchema.safeParse(event.params.versionId);
  if (!versionId.success) return fail(400, { error: 'Bad version id.' });

  const result = await moderateTrainingData({
    modelVersionId: versionId.data,
    approve,
    moderatorId: event.locals.user.id,
  });
  if (!result.ok) return fail(400, { error: result.error });

  // The version leaves the Paused queue. WHERE to go next is the client's business — it navigated
  // here and still holds that history; the action URL (`?/approve`) has replaced the page's own query
  // string, so this side could only guess.
  return { success: true };
};

export const actions: Actions = {
  approve: (event) => rule(event, true),
  deny: (event) => rule(event, false),

  reportCsam: requiresGrant('csam.report.file', async ({ request, params }) => {
    const versionId = idSchema.safeParse(params.versionId);
    if (!versionId.success) return fail(400, { error: 'Bad version id.' });

    const form = await request.formData();
    const input = z
      .object({ minorDepiction: z.enum(['real', 'non-real']) })
      .safeParse(Object.fromEntries(form));
    if (!input.success) return fail(400, { error: 'Pick whether the minor depicted is real.' });

    const contents = form
      .getAll('contents')
      .map(String)
      .filter((c): c is (typeof CSAM_CONTENT_KEYS)[number] =>
        (CSAM_CONTENT_KEYS as string[]).includes(c)
      );
    // The account reported is the version's owner, resolved here. A posted id would decide who gets a
    // CyberTipline report and a soft-delete, and nothing downstream cross-checks it against the version.
    const detail = await getTrainingVersionDetail(versionId.data);
    if (!detail) return fail(404, { error: 'Model version not found.' });

    const result = await reportTrainingDataCsam({
      userId: detail.userId,
      modelVersionId: versionId.data,
      minorDepiction: input.data.minorDepiction,
      contents,
    });
    if (!result.ok) return fail(400, { error: result.error });

    return { success: true, ...('warning' in result ? { warning: result.warning } : {}) };
  }),
};
