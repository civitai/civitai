import type { ChatCompletionStepTemplate } from '@civitai/orchestration-client';
import { submitWorkflow } from '@civitai/orchestration-client';
import { NsfwLevel } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { loadKyselyDb } from '~/server/db/kyselyDb.lazy';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import {
  readSfwModelNamesViaKysely,
  readSfwModelNamesViaPrisma,
} from '~/server/services/hot-reads-7.reads';
import { logToAxiom } from '~/server/logging/client';
import type { ModelMeta } from '~/server/schema/model.schema';
import { moderatorRuledNsfwSince } from '~/server/services/rating-review.entities';
import {
  COM_FACE_INTENT_LOCK_SOURCE,
  type ComFaceIntentListing,
  comFaceIntentFields,
  comFaceIntentTextHash,
  lockForComFaceIntent,
  readComFaceIntentModel,
  recordComFaceIntent,
  reusableComFaceIntent,
} from '~/server/services/model-com-face-intent.service';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import { previewComFaceIntent, previewTextScanNsfw } from '~/server/services/text-scan/preview';
import type { TextScanField } from '~/server/services/text-scan/types';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { browsingLevelLabels } from '~/shared/constants/browsingLevel.constants';
import { truncateModelName } from '~/shared/constants/model-name.constants';
import {
  COM_FACE_CHECK_UNAVAILABLE_MESSAGE,
  COM_FACE_REFUSED_EDIT_MESSAGE,
  COM_FACE_REFUSED_MESSAGE,
} from '~/shared/utils/model-sfw-face';
import { sanitizeHtml } from '~/utils/html-sanitize-helpers';
import { removeTags } from '~/utils/string-helpers';

const SFW_FACE_CHECK_WAIT_SECONDS = 10;
/** A dispute is judged by a job, with no owner waiting on the answer. */
const DISPUTE_CHECK_WAIT_SECONDS = 60;

/**
 * The .com titles of the given models that have a face on, for a viewer `showsSfwFace` admits.
 * Read at request time because the rows that name these models (image resources, notifications)
 * are cached or stored per image and per recipient, where a face change can't reach them.
 */
export async function getSfwModelNames(modelIds: number[], showSfwFace: boolean) {
  const ids = [...new Set(modelIds)];
  if (!showSfwFace || !ids.length) return new Map<number, string>();
  if (await isFlipt(FLIPT_FEATURE_FLAGS.KYSELY_HOT_READS_7))
    return readSfwModelNamesViaKysely((await loadKyselyDb()).kyselyRead, ids);
  return readSfwModelNamesViaPrisma(dbRead, ids);
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
  db = dbRead,
}: {
  sfwName?: string | null;
  sfwDescription?: string | null;
  modelId?: number;
  userId: number;
  /** The primary, for a caller reading an edit that has just committed. */
  db?: Pick<typeof dbRead, 'modelVersion'>;
}) {
  const versionFields = modelId ? await getOwnVersionFields({ modelId, userId, db }) : [];
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

async function getOwnVersionFields({
  modelId,
  userId,
  db,
}: {
  modelId: number;
  userId: number;
  db: Pick<typeof dbRead, 'modelVersion'>;
}) {
  const versions = await db.modelVersion.findMany({
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

export {
  COM_FACE_CHECK_UNAVAILABLE_MESSAGE,
  COM_FACE_REFUSED_EDIT_MESSAGE,
  COM_FACE_REFUSED_MESSAGE,
};

/** The intent check's verdict. `reason` is for moderators and logs only; never send it to the owner. */
export type ComFaceIntentVerdict =
  | { status: 'allowed' | 'unavailable'; promptId?: number }
  | { status: 'detected'; reason?: string; promptId?: number };

/**
 * The intent check on a model's own listing: its .red title, description and trigger words.
 * `unavailable` when no verdict came back.
 */
export async function checkComFaceIntent(args: ComFaceIntentListing) {
  return (await checkComFaceIntentVerdict(args)).status;
}

/** {@link checkComFaceIntent}, keeping the classifier's reason for a detection. `thinking` asks for
 *  the slower pass a dispute gets. */
export async function checkComFaceIntentVerdict({
  thinking,
  ...listing
}: ComFaceIntentListing & { thinking?: boolean }): Promise<ComFaceIntentVerdict> {
  const verdict = await previewComFaceIntent({
    fields: comFaceIntentFields(listing),
    waitSeconds: thinking ? DISPUTE_CHECK_WAIT_SECONDS : SFW_FACE_CHECK_WAIT_SECONDS,
    thinking,
  }).catch((error) => {
    logToAxiom({
      type: 'error',
      name: 'model-com-face-intent',
      message: error instanceof Error ? error.message : String(error),
    });
    return { status: 'unavailable' as const };
  });
  if (verdict.status !== 'ok') return { status: 'unavailable' };
  const { promptId } = verdict;
  return verdict.output.detected
    ? { status: 'detected', reason: verdict.output.reason, promptId }
    : { status: 'allowed', promptId };
}

/**
 * The owner's verdict on this listing text: the stored one while the text is unchanged, else a fresh
 * check, stored. A detection of the model's own stored listing on a mature model locks its nsfw
 * rating (`lockForComFaceIntent`), which the owner can dispute; that includes a stored detection
 * first made while the model was not mature, unless a moderator has ruled on its rating since.
 * `disputable`: the nsfw lock is now the intent check's. Nothing is read or stored unless `userId`
 * owns the model.
 */
async function resolveComFaceIntent({
  modelId,
  userId,
  ...listing
}: ComFaceIntentListing & { modelId?: number; userId?: number }): Promise<
  ComFaceIntentVerdict & { disputable?: boolean }
> {
  const found = modelId && userId ? await readComFaceIntentModel(modelId) : null;
  const model = found && found.userId === userId ? found : null;
  const textHash = comFaceIntentTextHash(listing);
  const stored = model ? reusableComFaceIntent(model.meta, textHash) : null;

  let verdict: ComFaceIntentVerdict;
  if (stored)
    verdict = stored.detected
      ? { status: 'detected', reason: stored.reason }
      : { status: 'allowed' };
  else {
    verdict = await checkComFaceIntentVerdict(listing);
    if (!model || verdict.status === 'unavailable') return verdict;
    await recordComFaceIntent(model.id, {
      detected: verdict.status === 'detected',
      textHash,
      ...(verdict.status === 'detected' && verdict.reason && { reason: verdict.reason }),
      ...(verdict.promptId && { promptId: verdict.promptId }),
    });
  }
  if (!model || verdict.status !== 'detected') return verdict;

  const meta = model.meta as ModelMeta | null;
  const intentLocked =
    !!model.lockedProperties?.includes('nsfw') &&
    meta?.systemNsfwLock?.source === COM_FACE_INTENT_LOCK_SOURCE;
  if (intentLocked) return { ...verdict, disputable: true };

  // Locked only for the text the model lists now, never for an unsaved edit or a draft.
  const storedHash = comFaceIntentTextHash({
    name: model.name,
    description: model.description,
    triggerWords: listing.triggerWords,
  });
  if (storedHash !== textHash || !model.nsfw) return verdict;
  // A stored detection a moderator has ruled past (an unlock from the model form) is not re-applied.
  const recordedAt = stored && meta?.comFaceIntent?.at ? new Date(meta.comFaceIntent.at) : null;
  if (recordedAt && (await moderatorRuledNsfwSince(model.id, recordedAt))) return verdict;

  const locked = await lockForComFaceIntent(model.id, textHash).catch((error: Error) => {
    logToAxiom({
      type: 'error',
      name: 'model-com-face-intent',
      message: 'lock not added',
      modelId: model.id,
      error: error.message,
    });
    return false;
  });
  return { ...verdict, disputable: locked };
}

/**
 * Refuses a .com face for a model whose own listing the intent check flags. Fails closed: no
 * verdict is a refusal. The refusal offers the dispute only while there is a lock to dispute. The
 * check also re-runs after a listing edit on a model that keeps a face (`recheckComFace`).
 */
export async function assertComFaceAllowed(
  args: ComFaceIntentListing & { modelId?: number; userId?: number }
) {
  const verdict = await resolveComFaceIntent(args);
  if (verdict.status === 'unavailable')
    throw throwBadRequestError(COM_FACE_CHECK_UNAVAILABLE_MESSAGE);
  if (verdict.status === 'detected') {
    // For moderators: the owner is told which fields were read, never why.
    logToAxiom({
      type: 'info',
      name: 'model-com-face-intent',
      message: 'refused at save',
      modelId: args.modelId,
      reason: verdict.reason,
    }).catch(() => undefined);
    throw throwBadRequestError(
      verdict.disputable ? COM_FACE_REFUSED_MESSAGE : COM_FACE_REFUSED_EDIT_MESSAGE
    );
  }
}

/**
 * The save-time gate: a .com face is stored only once its own text passes the check and the
 * model's listing passes the intent check.
 */
export async function assertSfwFaceSafe({
  sfwName,
  sfwDescription,
  name,
  description,
  modelId,
  userId,
}: {
  sfwName: string;
  sfwDescription?: string | null;
  name: string;
  description?: string | null;
  modelId?: number;
  userId: number;
}) {
  // Both checks wait on the orchestrator, so they run together; the listing refusal still wins.
  const triggerWords = modelId ? await getOwnTriggerWords({ modelId, userId }) : [];
  const [allowed, verdicts] = await Promise.allSettled([
    assertComFaceAllowed({ name, description, triggerWords, modelId, userId }),
    checkSfwFace({ sfwName, sfwDescription, userId }),
  ]);
  if (allowed.status === 'rejected') throw allowed.reason;
  if (verdicts.status === 'rejected') throw verdicts.reason;
  const entries = Object.entries(verdicts.value) as [SfwFaceCheckField, SfwFaceVerdict][];

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
  await assertComFaceAllowed({ name, description, triggerWords, modelId, userId });
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
    sfwName: truncateModelName(draft.title.trim()),
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

export async function getOwnTriggerWords({
  modelId,
  userId,
  db = dbRead,
}: {
  modelId: number;
  userId: number;
  db?: Pick<typeof dbRead, 'modelVersion'>;
}) {
  const versions = await db.modelVersion.findMany({
    where: { modelId, model: { userId } },
    select: { trainedWords: true },
    // A fixed order: the words feed the intent verdict's text hash.
    orderBy: { id: 'asc' },
  });
  return [...new Set(versions.flatMap((version) => version.trainedWords))];
}
