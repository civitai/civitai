import { error, fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { requiresGrant } from '$lib/server/access';
import {
  readMergeAnalysis,
  recentMergeAnalyses,
  submitMergeAnalysis,
} from '$lib/server/model-merge-analysis.service';
import { MAX_CANDIDATE_LORAS, MERGE_ANALYSIS_PATH } from '$lib/model-merge-analysis';
import type { Actions, PageServerLoad } from './$types';

const checkpointAir = z.string().regex(/^urn:air:unknown:checkpoint:civitai:\d+@\d+\+\d+$/);
const loraAir = z.string().regex(/^urn:air:unknown:lora:civitai:\d+@\d+\+\d+$/);
const label = z.string().trim().min(1).max(300);

const requestSchema = z
  .object({
    baseModel: checkpointAir,
    checkpoint: checkpointAir,
    baseModelLabel: label,
    checkpointLabel: label,
    loras: z.array(loraAir).min(1).max(MAX_CANDIDATE_LORAS),
    loraLabels: z.array(label),
    // Blank means "not given": the backend then assumes 1.
    strengths: z.array(
      z
        .string()
        .trim()
        .transform((v) => (v === '' ? undefined : Number(v)))
        .pipe(z.number().min(-10).max(10).optional())
    ),
  })
  .refine((r) => r.loras.length === r.strengths.length && r.loras.length === r.loraLabels.length);

const workflowId = z.string().regex(/^[\w-]{1,100}$/);

export const load: PageServerLoad = async ({ url }) => {
  const requested = url.searchParams.get('workflow');
  let current = null;
  if (requested !== null) {
    const id = workflowId.safeParse(requested);
    current = id.success ? await readMergeAnalysis(id.data) : null;
    if (current === null) error(404, 'This check was not found.');
  }
  return {
    // `undefined`: the orchestrator could not be asked, which is not an answer about the check.
    current: current ?? null,
    currentUnavailable: current === undefined,
    recent: recentMergeAnalyses().catch((e) => {
      console.error('[merge-analysis] recent checks failed', e);
      return null;
    }),
  };
};

export const actions: Actions = {
  check: requiresGrant('model.mergeAnalysis.run', async ({ request, locals }) => {
    const form = await request.formData();
    const parsed = requestSchema.safeParse({
      baseModel: form.get('baseModel'),
      checkpoint: form.get('checkpoint'),
      baseModelLabel: form.get('baseModelLabel'),
      checkpointLabel: form.get('checkpointLabel'),
      loras: form.getAll('lora'),
      loraLabels: form.getAll('loraLabel'),
      strengths: form.getAll('strength'),
    });
    if (!parsed.success)
      return fail(400, {
        error:
          'Choose a version for the checkpoint, the original base and every candidate LoRA, and keep strengths between -10 and 10.',
      });
    const { baseModel, checkpoint, loras, loraLabels, strengths } = parsed.data;

    const submitted = await submitMergeAnalysis(
      {
        baseModel,
        checkpoint,
        loras: loras.map((model, i) =>
          strengths[i] === undefined ? { model } : { model, strength: strengths[i] }
        ),
        labels: {
          baseModel: parsed.data.baseModelLabel,
          checkpoint: parsed.data.checkpointLabel,
          loras: loraLabels,
        },
      },
      locals.user!.id
    );
    if ('error' in submitted) return fail(502, { error: submitted.error });
    redirect(303, `${MERGE_ANALYSIS_PATH}?workflow=${encodeURIComponent(submitted.workflowId)}`);
  }),
};
