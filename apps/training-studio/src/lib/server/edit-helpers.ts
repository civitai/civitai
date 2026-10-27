import { error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { requireToken } from './token';
import { allowedModelFlags } from './flipt';
import { pairCardFlagKeys } from '$lib/data/trainingModels';
import { requestTextCheck } from './text-check';
import { orchestratorClient } from './orchestrator';
import {
  TrainingTextCheckError,
  TrainingTextRefusedError,
  textCheckFailureStatus,
} from '$lib/training-text';
import * as core from '$lib/edit-helpers-core';

const isBlobUrl = core.isOrchestratorBlobUrl;
const isCurrencies = (v: unknown): v is string[] | undefined =>
  v === undefined || (Array.isArray(v) && v.length <= 3 && v.every((c) => typeof c === 'string'));

const UNAVAILABLE = 'This helper is unavailable right now — no orchestrator token.';

/** The helpers' orchestrator client, for a caller who may see an edit card — they charge Buzz and
 *  generate, so they stay behind the same gate as the card that offers them. Call it before reading
 *  the request, so a refused caller costs no prompt check. */
export async function helperClient(locals: App.Locals) {
  const keys = pairCardFlagKeys();
  if (keys && !locals.devPreview && (await allowedModelFlags(locals.user, keys)).length === 0)
    error(403, 'Edit training is not available on your account yet.');
  return orchestratorClient(await requireToken(locals, UNAVAILABLE));
}

/** Parse and check a "create the after image" body. The prompt goes through the main app's prompt
 *  check — the run is charged and generates from it — so a refusal is a 400 with its reason. */
export async function editImageRequest({
  locals,
  request,
}: RequestEvent): Promise<core.EditImageRequest> {
  const body = (await request.json().catch(() => null)) as Partial<core.EditImageRequest> | null;
  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
  if (
    !body ||
    !isBlobUrl(body.imageUrl) ||
    !prompt ||
    prompt.length > 1500 ||
    !isCurrencies(body.currencies)
  )
    error(400, 'Bad image request.');
  const cookie = locals.devPreview ? null : request.headers.get('cookie') ?? '';
  try {
    await requestTextCheck(
      cookie,
      locals.user.id
    )({ editPrompt: prompt, inputImages: [body.imageUrl] });
  } catch (err) {
    if (err instanceof TrainingTextRefusedError) error(400, err.message);
    if (err instanceof TrainingTextCheckError) error(textCheckFailureStatus(err), err.message);
    throw err;
  }
  return { imageUrl: body.imageUrl, prompt, currencies: body.currencies };
}

export async function suggestRequest({ request }: RequestEvent): Promise<core.SuggestRequest> {
  const body = (await request.json().catch(() => null)) as Partial<core.SuggestRequest> | null;
  if (
    !body ||
    !isBlobUrl(body.beforeUrl) ||
    !isBlobUrl(body.afterUrl) ||
    !isCurrencies(body.currencies)
  )
    error(400, 'Bad suggestion request.');
  return { beforeUrl: body.beforeUrl, afterUrl: body.afterUrl, currencies: body.currencies };
}
