import type { ChatCompletionStepTemplate } from '@civitai/orchestration-client';
import { getWorkflow, submitWorkflow } from '@civitai/orchestration-client';
import { logToAxiom } from '~/server/logging/client';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import { getCategoryTags } from '~/server/services/system-cache';
import type { ChatCompletionStepLike } from '~/server/services/text-scan/parse';
import { tryParseJson } from '~/server/services/text-scan/parse';
import { getTextScanProfile, isTextScanEntityType } from '~/server/services/text-scan/profiles';
import { textScanTextHash } from '~/server/services/text-scan/prompt';
import { segmentUserText } from '~/server/services/text-scan/segment';
import type {
  TextScanCategoryHook,
  TextScanEntityType,
  TextScanSubject,
} from '~/server/services/text-scan/types';

export const TEXT_CATEGORY_TAG = 'text-category';
export const TEXT_CATEGORY_CALLBACK_PASS = 'category';
const MAX_OUTPUT_TOKENS = 256;

function log(type: 'error' | 'warning' | 'info', message: string, extra: Record<string, unknown>) {
  return logToAxiom({ name: 'text-category', type, message, ...extra });
}

/** Authors cannot pick adminOnly categories, so the model is not offered them either. */
export async function getPickableCategories(hook: TextScanCategoryHook) {
  const tags = await getCategoryTags(hook.tagType);
  return tags.filter((tag) => !tag.adminOnly).map(({ id, name }) => ({ id, name }));
}

export function buildTextCategorySystemPrompt(names: string[]) {
  return [
    'You sort a post into exactly one category. Read its title and content and choose the category',
    'that best describes what it is about, whatever category its author gave it.',
    'Answer with JSON: {"category": "<name>"}, where <name> is one of these, spelled exactly:',
    ...names.map((name) => `- ${name}`),
  ].join('\n');
}

export function buildTextCategoryResponseFormat(names: string[]) {
  return {
    type: 'json_schema' as const,
    jsonSchema: {
      name: 'text_category',
      schema: {
        type: 'object',
        properties: { category: { type: 'string', enum: [...names] } },
        required: ['category'],
        additionalProperties: false,
      },
      strict: true,
    },
  };
}

/** The offered name the model chose, or null for anything else. Never throws. */
export function parseTextCategoryStep(
  step: ChatCompletionStepLike | undefined,
  names: readonly string[]
): string | null {
  const content = step?.output?.choices?.[0]?.message?.content;
  const json = step?.output?.parsed ?? (content ? tryParseJson(content) : undefined);
  const value = (json as { category?: unknown } | undefined)?.category;
  return typeof value === 'string' && names.includes(value) ? value : null;
}

/** The scan callback URL, marked so the webhook routes it here instead of to the scan callback. */
export function textCategoryCallbackUrl(scanCallbackUrl: string) {
  const url = new URL(scanCallbackUrl);
  url.searchParams.set('pass', TEXT_CATEGORY_CALLBACK_PASS);
  return url.toString();
}

type TextCategoryWorkflowMetadata = {
  entityType?: string;
  entityId?: number;
  textHash?: string;
  categories?: string[];
};

// Separate workflow, not a scan step: the scan request must stay byte-identical.
export async function submitTextCategoryScan({
  entityType,
  entityId,
  subject,
  hook,
  model,
  maxInputChars,
  scanCallbackUrl,
}: {
  entityType: TextScanEntityType;
  entityId: number;
  subject: TextScanSubject;
  hook: TextScanCategoryHook;
  model: string;
  maxInputChars: number;
  scanCallbackUrl: string;
}) {
  const names = (await getPickableCategories(hook)).map((c) => c.name);
  if (!names.length) return log('warning', 'no categories to offer', { entityType, entityId });
  // One segment: the opening suffices and cost stays flat.
  const [user] = segmentUserText(subject, { budget: maxInputChars, maxSegments: 1 }).segments;
  if (!user?.trim()) return;

  const metadata: TextCategoryWorkflowMetadata = {
    entityType,
    entityId,
    textHash: textScanTextHash(subject),
    categories: names,
  };
  // The generated ChatCompletionMessage type declares only `role`; content is untyped upstream.
  const input: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: buildTextCategorySystemPrompt(names) },
      { role: 'user', content: user },
    ],
    temperature: 0,
    maxTokens: MAX_OUTPUT_TOKENS,
    chatTemplateKwargs: { enable_thinking: false },
    responseFormat: buildTextCategoryResponseFormat(names),
  };
  const step = {
    $type: 'chatCompletion',
    name: 'textCategory',
    input,
  } as ChatCompletionStepTemplate;

  const { data, error } = await submitWorkflow({
    client: internalOrchestratorClient,
    body: {
      metadata,
      tags: [TEXT_CATEGORY_TAG, entityType],
      currencies: [],
      steps: [step],
      callbacks: [
        {
          url: textCategoryCallbackUrl(scanCallbackUrl),
          type: ['workflow:succeeded', 'workflow:failed', 'workflow:expired', 'workflow:canceled'],
        },
      ],
    },
  });
  if (!data?.id)
    await log('error', 'submit failed', {
      entityType,
      entityId,
      error: error instanceof Error ? error.message : error,
    });
}

/** Logs and returns on every failure: there is no record or retry for it to leave in a bad state. */
export async function handleTextCategoryCallback(event: { workflowId: string; status: string }) {
  const { workflowId } = event;
  try {
    const { data } = await getWorkflow({
      client: internalOrchestratorClient,
      path: { workflowId },
    });
    const metadata = (data?.metadata ?? {}) as TextCategoryWorkflowMetadata;
    const { entityType, entityId, categories } = metadata;
    const ctx = { workflowId, entityType, entityId };
    if (
      !data ||
      !(data.tags ?? []).includes(TEXT_CATEGORY_TAG) ||
      !entityType ||
      !isTextScanEntityType(entityType) ||
      entityId === undefined ||
      !Array.isArray(categories)
    )
      return log('warning', 'callback for a workflow text-category does not own', ctx);

    const profile = getTextScanProfile(entityType);
    if (!profile?.category) return log('warning', 'profile has no category hook', ctx);
    const { write } = profile.category;

    const subject = (await profile.load([entityId])).get(entityId);
    if (!subject) return log('info', 'subject gone', ctx);
    // An edit since submit has its own call in flight; this answer is about the old text.
    if (metadata.textHash && textScanTextHash(subject) !== metadata.textHash)
      return log('info', 'text changed since submit', ctx);
    // From here the answer is about the current text, so no answer clears the old text's category.
    const clear = async (message: string, extra: Record<string, unknown> = {}) => {
      await write(entityId, null);
      await log('info', `${message}; category cleared`, { ...ctx, ...extra });
    };
    if (event.status !== 'succeeded') return clear(`workflow ${event.status}`);
    if (subject.notPublic) return clear('subject not public');

    const steps = (data.steps ?? []) as ChatCompletionStepLike[];
    const name = parseTextCategoryStep(
      steps.find((s) => s?.$type === 'chatCompletion'),
      categories
    );
    if (!name) return clear('unusable output');

    const tag = (await getPickableCategories(profile.category)).find((t) => t.name === name);
    if (!tag) return clear('category no longer offered', { name });

    await write(entityId, tag.id);
    await log('info', 'category written', { ...ctx, name, tagId: tag.id });
  } catch (error) {
    await log('error', 'callback failed', { workflowId, error: (error as Error).message }).catch(
      () => undefined
    );
  }
}
