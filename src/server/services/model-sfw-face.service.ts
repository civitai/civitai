import type { ChatCompletionStepTemplate } from '@civitai/orchestration-client';
import { submitWorkflow } from '@civitai/orchestration-client';
import { NsfwLevel } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import { previewTextScanNsfw } from '~/server/services/text-scan/preview';
import type { TextScanField } from '~/server/services/text-scan/types';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { browsingLevelLabels } from '~/shared/constants/browsingLevel.constants';
import { sanitizeHtml } from '~/utils/html-sanitize-helpers';
import { removeTags } from '~/utils/string-helpers';

const SFW_FACE_CHECK_WAIT_SECONDS = 10;

/**
 * The .com titles of the given models that have a face on, for a viewer `showsSfwFace` admits.
 * Read at request time because the rows that name these models (image resources, notifications)
 * are cached or stored per image and per recipient, where a face change can't reach them.
 */
export async function getSfwModelNames(modelIds: number[], showSfwFace: boolean) {
  const ids = [...new Set(modelIds)];
  if (!showSfwFace || !ids.length) return new Map<number, string>();
  const models = await dbRead.model.findMany({
    where: { id: { in: ids }, sfwName: { not: null } },
    select: { id: true, sfwName: true },
  });
  return new Map(models.map((model) => [model.id, model.sfwName as string]));
}

export type SfwFaceVerdict =
  | { status: 'clean' }
  | { status: 'flagged'; level: string; reason: string }
  | { status: 'unavailable' };

export type SfwFaceCheckField = 'sfwName' | 'sfwDescription' | 'versions';

/** Rated by the text-scan, the classifier that decides a model's nsfw flag: .com takes PG-13 or below. */
async function checkFields(fields: TextScanField[]): Promise<SfwFaceVerdict> {
  try {
    const preview = await previewTextScanNsfw({ fields, waitSeconds: SFW_FACE_CHECK_WAIT_SECONDS });
    if (preview.status !== 'ok') return { status: 'unavailable' };
    if (preview.level <= NsfwLevel.PG13) return { status: 'clean' };
    return {
      status: 'flagged',
      level: browsingLevelLabels[preview.level as keyof typeof browsingLevelLabels] ?? 'mature',
      reason: preview.reason,
    };
  } catch (error) {
    logToAxiom({
      type: 'error',
      name: 'model-sfw-face-check',
      message: error instanceof Error ? error.message : String(error),
    });
    return { status: 'unavailable' };
  }
}

/**
 * Checks the .com face for content that would be mature on civitai.com. `versions` covers the
 * version names and trigger words of the caller's own model, which show on .com unchanged.
 */
export async function checkSfwFace({
  sfwName,
  sfwDescription,
  modelId,
  userId,
}: {
  sfwName?: string | null;
  sfwDescription?: string | null;
  modelId?: number;
  userId: number;
}) {
  const versionFields = modelId ? await getOwnVersionFields({ modelId, userId }) : [];
  const description = removeTags(sfwDescription ?? '').trim();

  const [name, desc, versions] = await Promise.all([
    sfwName?.trim() ? checkFields([{ heading: 'Name', text: sfwName }]) : undefined,
    description ? checkFields([{ heading: 'Description', text: description }]) : undefined,
    versionFields.length ? checkFields(versionFields) : undefined,
  ]);

  const verdicts: Partial<Record<SfwFaceCheckField, SfwFaceVerdict>> = {};
  if (name) verdicts.sfwName = name;
  if (desc) verdicts.sfwDescription = desc;
  if (versions) verdicts.versions = versions;
  return verdicts;
}

async function getOwnVersionFields({ modelId, userId }: { modelId: number; userId: number }) {
  const versions = await dbRead.modelVersion.findMany({
    where: { modelId, model: { userId } },
    select: { name: true, trainedWords: true },
  });
  return versions.flatMap((version): TextScanField[] => [
    { heading: 'Version name', text: version.name },
    ...(version.trainedWords.length
      ? [{ heading: 'Trained words', text: version.trainedWords.join(', ') }]
      : []),
  ]);
}

const fieldLabels: Record<SfwFaceCheckField, string> = {
  sfwName: '.com title',
  sfwDescription: '.com description',
  versions: 'version names and trigger words',
};

/** The save-time gate: a .com face is stored only once its own text passes the check. */
export async function assertSfwFaceSafe({
  sfwName,
  sfwDescription,
  userId,
}: {
  sfwName: string;
  sfwDescription?: string | null;
  userId: number;
}) {
  const verdicts = await checkSfwFace({ sfwName, sfwDescription, userId });
  const entries = Object.entries(verdicts) as [SfwFaceCheckField, SfwFaceVerdict][];

  const flagged = entries.filter(([, verdict]) => verdict.status === 'flagged');
  if (flagged.length)
    throw throwBadRequestError(
      `The ${flagged
        .map(([field]) => fieldLabels[field])
        .join(' and ')} can't be shown on civitai.com. Edit it and save again.`
    );

  if (entries.some(([, verdict]) => verdict.status === 'unavailable'))
    throw throwBadRequestError(
      "We couldn't check the civitai.com title and description just now. Try saving again."
    );
}

const DRAFT_MODEL = 'openai/gpt-4o-mini';
const DRAFT_WAIT_SECONDS = 45;

const DRAFT_SYSTEM_PROMPT = `You rewrite the listing of an AI model (a LoRA, checkpoint or similar) so it can be shown on civitai.com, a site that shows no mature content.

Rules:
- Remove or neutralise sexual, explicit, suggestive and fetish language. Do not describe nudity or sexual acts.
- Keep everything a user needs to use the model: what it does, the base model, trigger words exactly as given, recommended settings, usage notes, changelog and links.
- Keep the creator's voice and structure. Do not add claims, ratings or new content.
- The title names the model's style, subject or purpose with no sexual, nude, body-part, clothing-state or fetish words. Rename it when needed; keep the original name only when it is already suitable.
- The description is HTML using only <p>, <h3>, <ul>, <ol>, <li>, <strong>, <em>, <code> and <a href>.
- If the text is already suitable, return it with minimal changes.`;

const DRAFT_RESPONSE_FORMAT = {
  type: 'json_schema',
  jsonSchema: {
    name: 'com_listing',
    strict: true,
    schema: {
      type: 'object',
      properties: { title: { type: 'string' }, description: { type: 'string' } },
      required: ['title', 'description'],
      additionalProperties: false,
    },
  },
};

/** Drafts a .com title and description from the .red ones. Nothing is saved. */
export async function draftSfwFace({
  name,
  description,
  modelId,
  userId,
}: {
  name: string;
  description?: string | null;
  modelId?: number;
  userId: number;
}) {
  const triggerWords = modelId ? await getOwnTriggerWords({ modelId, userId }) : [];
  const source = JSON.stringify({ title: name, description: description ?? '', triggerWords });
  let draft = await requestDraft([{ role: 'user', content: source }], userId);

  // One revision when the check still flags the draft, telling the model what it missed.
  const verdicts = await checkSfwFace({
    sfwName: draft.title,
    sfwDescription: draft.description,
    userId,
  });
  const feedback = flaggedFeedback(verdicts);
  if (feedback)
    draft = await requestDraft(
      [
        { role: 'user', content: source },
        { role: 'assistant', content: JSON.stringify(draft) },
        { role: 'user', content: feedback },
      ],
      userId
    ).catch(() => draft);

  return {
    sfwName: draft.title.trim().slice(0, 255),
    sfwDescription: sanitizeHtml(draft.description),
  };
}

async function requestDraft(conversation: { role: string; content: string }[], userId: number) {
  // The client types a message as `{ role }` only; the content rides along untyped.
  const messages = [{ role: 'system', content: DRAFT_SYSTEM_PROMPT }, ...conversation];
  const step: ChatCompletionStepTemplate = {
    $type: 'chatCompletion',
    input: {
      model: DRAFT_MODEL,
      temperature: 0.3,
      responseFormat: DRAFT_RESPONSE_FORMAT,
      messages,
    },
  };

  const { data } = await submitWorkflow({
    client: internalOrchestratorClient,
    query: { wait: DRAFT_WAIT_SECONDS },
    body: { metadata: { purpose: 'model-sfw-face-draft', userId }, currencies: [], steps: [step] },
  }).catch(() => ({ data: undefined }));

  const content = (
    data?.steps?.[0] as { output?: { choices?: { message?: { content?: string } }[] } } | undefined
  )?.output?.choices?.[0]?.message?.content;
  const draft = parseDraft(content);
  if (data?.status !== 'succeeded' || !draft)
    throw throwBadRequestError("We couldn't draft a civitai.com version just now. Try again.");
  return draft;
}

function flaggedFeedback(verdicts: Partial<Record<SfwFaceCheckField, SfwFaceVerdict>>) {
  const problems = (['sfwName', 'sfwDescription'] as const).flatMap((field) => {
    const verdict = verdicts[field];
    if (verdict?.status !== 'flagged') return [];
    const part = field === 'sfwName' ? 'title' : 'description';
    return [`The ${part} is still rated ${verdict.level}: ${verdict.reason}`];
  });
  if (!problems.length) return null;
  return `${problems.join(
    ' '
  )} Rewrite it so it is suitable for civitai.com and answer with the same JSON shape.`;
}

function parseDraft(content: string | undefined) {
  if (!content) return null;
  try {
    const parsed = JSON.parse(content) as { title?: unknown; description?: unknown };
    if (typeof parsed.title !== 'string' || !parsed.title.trim()) return null;
    return {
      title: parsed.title,
      description: typeof parsed.description === 'string' ? parsed.description : '',
    };
  } catch {
    return null;
  }
}

async function getOwnTriggerWords({ modelId, userId }: { modelId: number; userId: number }) {
  const versions = await dbRead.modelVersion.findMany({
    where: { modelId, model: { userId } },
    select: { trainedWords: true },
  });
  return [...new Set(versions.flatMap((version) => version.trainedWords))];
}
