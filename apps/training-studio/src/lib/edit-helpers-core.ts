// Client-safe orchestrator calls behind the edit-LoRA Data step's helpers: the caller's past image
// edits as ready pairs, generating an after image, and suggesting an instruction. Like
// orchestrator-core, each takes an already-built client, so the shell's routes and the web
// component share them. Generation and suggestion are charged to the caller's token.
import {
  getWorkflow,
  submitWorkflow,
  type WorkflowStepTemplate,
} from '@civitai/orchestration-client';
import { CIVITAI_TAG } from '$lib/data/trainingRows';
import {
  describeSubmitError,
  isUsableBlob,
  MAX_GENERATION_ITEMS,
  queryRecentWorkflows,
  resolveCurrencies,
  TERMINAL_STATUSES,
  WHATIF_CURRENCIES,
  whatIfCost,
  type OrchestratorClient,
  type OutputBlob,
} from './orchestrator-core';

/** One past image edit: the image it started from, one of its results, and the prompt that made it. */
export interface EditGenerationItem {
  workflowId: string;
  /** The edit's input image — an orchestrator blob URL, read with the workflow's authorisation. */
  sourceUrl: string;
  resultBlobId: string;
  resultUrl: string;
  previewUrl: string;
  prompt: string;
  nsfwLevel?: string;
}

interface RawImageGenStep {
  $type?: string;
  input?: { images?: unknown; prompt?: unknown };
  output?: { images?: OutputBlob[] };
}

const ORCHESTRATOR_BLOB_PATH = '/v2/consumer/blobs/';
// The generator tags every workflow with its workflow key; an image edit is this one.
const EDIT_WORKFLOW_TAG = 'img2img:edit';

/** The caller's recent single-image edits, one item per result. Edits from several input images
 *  are left out — a pair has one starting image — and so are inputs that aren't the caller's
 *  orchestrator blobs (a site image remixed in), whose bytes the Studio can't read. */
export async function listEditGenerations(
  client: OrchestratorClient
): Promise<EditGenerationItem[]> {
  const workflows = await queryRecentWorkflows(client, [
    CIVITAI_TAG,
    'gen',
    'img',
    EDIT_WORKFLOW_TAG,
  ]);

  const items: EditGenerationItem[] = [];
  const seen = new Set<string>();
  for (const workflow of workflows) {
    if (!workflow.id) continue;
    const params = (workflow.metadata as { params?: { prompt?: unknown } } | null)?.params;
    for (const step of (workflow.steps ?? []) as RawImageGenStep[]) {
      if (step.$type !== 'imageGen') continue;
      const inputs = step.input?.images;
      if (!Array.isArray(inputs) || inputs.length !== 1 || typeof inputs[0] !== 'string') continue;
      const sourceUrl = inputs[0];
      if (!sourceUrl.includes(ORCHESTRATOR_BLOB_PATH)) continue;
      const prompt = [step.input?.prompt, params?.prompt].find(
        (p): p is string => typeof p === 'string' && p.trim().length > 0
      );
      if (!prompt) continue;
      for (const blob of step.output?.images ?? []) {
        if (!isUsableBlob(blob) || seen.has(blob.id)) continue;
        seen.add(blob.id);
        items.push({
          workflowId: workflow.id,
          sourceUrl,
          resultBlobId: blob.id,
          resultUrl: blob.url,
          previewUrl: blob.previewUrl ?? blob.url,
          prompt: prompt.trim(),
          nsfwLevel: blob.nsfwLevel ?? undefined,
        });
      }
    }
    if (items.length >= MAX_GENERATION_ITEMS) break;
  }
  return items.slice(0, MAX_GENERATION_ITEMS);
}

// Tagged apart from `gen` so the helpers' outputs never show up in the caller's generation feed or
// in "From my edit generations".
const HELPER_TAGS = [CIVITAI_TAG, 'training-studio-edit-helper'];
// Never fetched by a whatif.
const WHATIF_IMAGE = 'https://example.com/whatif.png';

/** `/v2/consumer/blobs/` URLs only: a helper reads the caller's own uploads and generations, never an
 *  arbitrary image off the web. */
export const isOrchestratorBlobUrl = (url: unknown): url is string =>
  typeof url === 'string' &&
  url.length <= 2000 &&
  url.startsWith('https://') &&
  url.includes(ORCHESTRATOR_BLOB_PATH);

async function submit(
  client: OrchestratorClient,
  step: WorkflowStepTemplate,
  currencies: string[] | undefined,
  what: string
): Promise<string> {
  const { data, error, response } = await submitWorkflow({
    client,
    body: {
      tags: HELPER_TAGS,
      steps: [step],
      currencies: resolveCurrencies(currencies, WHATIF_CURRENCIES),
      // Generated media never comes back mature, whatever the starting image: the Studio can't tell
      // which site the result will be shown on, and the generator's own mature rules are per site.
      allowMatureContent: false,
    },
    query: { wait: 0 },
  });
  if (!data?.id) throw new Error(`${what} failed: ${describeSubmitError(error, response?.status)}`);
  return data.id;
}

async function readStep(client: OrchestratorClient, workflowId: string) {
  const { data, error } = await getWorkflow({ client, path: { workflowId } });
  if (!data) throw new Error(`poll failed: ${error?.detail ?? 'no data returned'}`);
  const step = data.steps?.[0] as { status?: string; output?: unknown } | undefined;
  return { done: TERMINAL_STATUSES.has(data.status), step };
}

/** How many options one "create the after image" run produces. */
export const EDIT_IMAGE_OPTIONS = 3;

// Flux.2 Klein 9B distilled, at the generator's own fixed steps/CFG for it: the same model family
// the LoRA trains on, run on Civitai's hardware.
function editImageStep(imageUrl: string, prompt: string): WorkflowStepTemplate {
  return {
    $type: 'imageGen',
    input: {
      engine: 'flux2',
      model: 'klein',
      modelVersion: '9b',
      operation: 'editImage',
      prompt,
      images: [imageUrl],
      quantity: EDIT_IMAGE_OPTIONS,
      steps: 12,
      cfgScale: 1,
      sampleMethod: 'euler',
      schedule: 'simple',
    },
  } as unknown as WorkflowStepTemplate;
}

export interface EditImageRequest {
  /** The starting image, as a URL the orchestrator can read (the blob's own URL). */
  imageUrl: string;
  prompt: string;
  currencies?: string[];
}

export interface EditImageOption {
  blobId: string;
  url: string;
  nsfwLevel?: string;
}

export const editImageQuote = (client: OrchestratorClient) =>
  whatIfCost(client, editImageStep(WHATIF_IMAGE, 'whatif'), 'whatif');

export const submitEditImage = (client: OrchestratorClient, req: EditImageRequest) =>
  submit(client, editImageStep(req.imageUrl, req.prompt.trim()), req.currencies, 'image edit');

/** `options` holds every result that came back usable — blocked or unavailable ones are dropped, so
 *  a finished run can return fewer than were asked for. */
export async function pollEditImage(
  client: OrchestratorClient,
  workflowId: string
): Promise<{ done: boolean; options: EditImageOption[] }> {
  const { done, step } = await readStep(client, workflowId);
  const images = (step?.output as { images?: OutputBlob[] } | undefined)?.images ?? [];
  const options = images
    .filter(isUsableBlob)
    .map((b) => ({ blobId: b.id, url: b.url, nsfwLevel: b.nsfwLevel ?? undefined }));
  return { done, options };
}

// Must carry its provider prefix: the orchestrator prices nothing it can't resolve.
const SUGGEST_MODEL = 'openai/gpt-4o-mini';
const SUGGEST_SYSTEM = [
  'You write the instruction for one example in an image-editing dataset.',
  'You are shown the image before the edit, then the image after it.',
  'Reply with one short imperative instruction that turns the first image into the second,',
  'such as "Turn the person 90 degrees to their left" or "Put the logo on the front of the shirt".',
  'Describe only what changed. No preamble, no quotes, no explanation.',
].join(' ');

function suggestStep(beforeUrl: string, afterUrl: string): WorkflowStepTemplate {
  return {
    $type: 'chatCompletion',
    input: {
      model: SUGGEST_MODEL,
      temperature: 0.2,
      maxTokens: 80,
      messages: [
        { role: 'system', content: SUGGEST_SYSTEM },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Before:' },
            { type: 'image_url', image_url: { url: beforeUrl, detail: 'low' } },
            { type: 'text', text: 'After:' },
            { type: 'image_url', image_url: { url: afterUrl, detail: 'low' } },
          ],
        },
      ],
    },
  } as unknown as WorkflowStepTemplate;
}

export interface SuggestRequest {
  beforeUrl: string;
  afterUrl: string;
  currencies?: string[];
}

export const suggestQuote = (client: OrchestratorClient) =>
  whatIfCost(client, suggestStep(WHATIF_IMAGE, WHATIF_IMAGE), 'whatif');

export const submitSuggest = (client: OrchestratorClient, req: SuggestRequest) =>
  submit(client, suggestStep(req.beforeUrl, req.afterUrl), req.currencies, 'suggestion');

/** `text` is set once the model answered; a finished run without one failed. */
export async function pollSuggest(
  client: OrchestratorClient,
  workflowId: string
): Promise<{ done: boolean; text?: string }> {
  const { done, step } = await readStep(client, workflowId);
  const content = (step?.output as { choices?: { message?: { content?: unknown } }[] } | undefined)
    ?.choices?.[0]?.message?.content;
  const text =
    typeof content === 'string'
      ? content
          .trim()
          .replace(/^["“]|["”]$/g, '')
          .trim()
      : undefined;
  return { done, text: text || undefined };
}
