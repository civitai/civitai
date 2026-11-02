import { error, json } from '@sveltejs/kit';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { requireToken } from './token';
import { allowedModelFlags } from './flipt';
import { pairCardFlagKeys } from '$lib/data/trainingModels';
import { requestTextCheck, textCheckCookie, throwTextCheckHttpError } from './text-check';
import { orchestratorClient } from './orchestrator';
import type { OrchestratorClient } from '$lib/orchestrator-core';
import * as core from '$lib/edit-helpers-core';

const isBlobUrl = core.isOrchestratorBlobUrl;
const isCurrencies = (v: unknown): v is string[] | undefined =>
  v === undefined || (Array.isArray(v) && v.length <= 3 && v.every((c) => typeof c === 'string'));

const UNAVAILABLE = 'This helper is unavailable right now — no orchestrator token.';

/** The helpers' orchestrator client, for a caller who may see an edit card — they charge Buzz and
 *  generate, so they stay behind the same gate as the card that offers them. Call it before reading
 *  the request, so a refused caller costs no prompt check. */
async function helperClient(locals: App.Locals) {
  const keys = pairCardFlagKeys();
  if (keys && !locals.devPreview && (await allowedModelFlags(locals.user, keys)).length === 0)
    error(403, 'Edit training is not available on your account yet.');
  return orchestratorClient(await requireToken(locals, UNAVAILABLE));
}

/** Parse and check a "create the after image" body. The prompt goes through the main app's prompt
 *  check — the run is charged and generates from it — so a refusal is a 400 with its reason. */
async function editImageRequest({ locals, request }: RequestEvent): Promise<core.EditImageRequest> {
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
  try {
    await requestTextCheck(
      textCheckCookie(locals, request),
      locals.user.id
    )({ editPrompt: prompt, inputImages: [body.imageUrl] });
  } catch (err) {
    throwTextCheckHttpError(err);
    throw err;
  }
  return { imageUrl: body.imageUrl, prompt, currencies: body.currencies };
}

async function suggestRequest({ request }: RequestEvent): Promise<core.SuggestRequest> {
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

/** A helper's quote (GET; null when unpriced, so its button just can't name a cost) and submit (POST,
 *  answering the workflow id to poll). `what` names it in the logs. */
function helperRoutes<Req>(
  what: string,
  submitFailure: string,
  quote: (client: OrchestratorClient) => Promise<number | null>,
  parse: (event: RequestEvent) => Promise<Req>,
  submit: (client: OrchestratorClient, req: Req) => Promise<string>
): { GET: RequestHandler; POST: RequestHandler } {
  return {
    GET: async ({ locals }) => {
      const client = await helperClient(locals);
      try {
        return json({ cost: await quote(client) });
      } catch (err) {
        console.warn(`[training-studio] ${what} quote failed`, err);
        return json({ cost: null });
      }
    },
    POST: async (event) => {
      const client = await helperClient(event.locals);
      const req = await parse(event);
      try {
        return json({ workflowId: await submit(client, req) });
      } catch (err) {
        console.warn(`[training-studio] ${what} submit failed`, err);
        error(502, submitFailure);
      }
    },
  };
}

// The token scopes to the caller, so only the caller's own runs are readable.
function helperPollRoute(
  what: string,
  pollFailure: string,
  poll: (client: OrchestratorClient, workflowId: string) => Promise<unknown>
): RequestHandler<{ id: string }> {
  return async ({ locals, params }) => {
    const client = await helperClient(locals);
    try {
      return json(await poll(client, params.id));
    } catch (err) {
      console.warn(`[training-studio] ${what} poll failed`, err);
      error(502, pollFailure);
    }
  };
}

export const editImageRoutes = helperRoutes(
  'edit image',
  "Couldn't create the image. Try again.",
  core.editImageQuote,
  editImageRequest,
  core.submitEditImage
);
export const editImagePollRoute = helperPollRoute(
  'edit image',
  'Could not read the image progress.',
  core.pollEditImage
);

export const suggestRoutes = helperRoutes(
  'suggest',
  "Couldn't suggest an instruction. Try again.",
  core.suggestQuote,
  suggestRequest,
  core.submitSuggest
);
export const suggestPollRoute = helperPollRoute(
  'suggest',
  'Could not read the suggestion.',
  core.pollSuggest
);
