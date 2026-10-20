import type { XGuardModerationOutput } from '@civitai/client';
import { dbRead } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  collectMatchedTerms,
  triggeredLabelKeys,
} from '~/server/services/moderation-label-helpers';
import { createXGuardModerationRequest } from '~/server/services/orchestrator/orchestrator.service';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { removeTags } from '~/utils/string-helpers';

/** The labels that set `Model.nsfw` on the .red text are the ones a .com field must clear. */
const SFW_FACE_CHECK_LABELS = ['NSFW', 'Suggestive', 'Explicit'];
const SFW_FACE_CHECK_WAIT_SECONDS = 10;

export type SfwFaceVerdict =
  | { status: 'clean' }
  | { status: 'flagged'; labels: string[]; terms: string[] }
  | { status: 'unavailable' };

export type SfwFaceCheckField = 'sfwName' | 'sfwDescription' | 'versions';

async function checkText(text: string, userId: number): Promise<SfwFaceVerdict> {
  try {
    const workflow = await createXGuardModerationRequest({
      mode: 'text',
      content: text,
      labels: SFW_FACE_CHECK_LABELS,
      userId,
      wait: SFW_FACE_CHECK_WAIT_SECONDS,
      priority: 'high',
      // A preview: no callback means no audit row and no moderation action.
      callbackUrl: null,
    });
    const step = workflow?.steps?.[0] as { output?: XGuardModerationOutput } | undefined;
    if (workflow?.status !== 'succeeded' || !step?.output) return { status: 'unavailable' };

    const triggered = triggeredLabelKeys(step.output);
    if (!triggered.size) return { status: 'clean' };
    return {
      status: 'flagged',
      labels: [...triggered],
      terms: collectMatchedTerms(step.output, triggered),
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
  const versionText = modelId ? await getOwnVersionText({ modelId, userId }) : '';
  const description = removeTags(sfwDescription ?? '').trim();

  const [name, desc, versions] = await Promise.all([
    sfwName?.trim() ? checkText(sfwName, userId) : undefined,
    description ? checkText(description, userId) : undefined,
    versionText ? checkText(versionText, userId) : undefined,
  ]);

  const verdicts: Partial<Record<SfwFaceCheckField, SfwFaceVerdict>> = {};
  if (name) verdicts.sfwName = name;
  if (desc) verdicts.sfwDescription = desc;
  if (versions) verdicts.versions = versions;
  return verdicts;
}

async function getOwnVersionText({ modelId, userId }: { modelId: number; userId: number }) {
  const versions = await dbRead.modelVersion.findMany({
    where: { modelId, model: { userId } },
    select: { name: true, trainedWords: true },
  });
  return versions
    .flatMap((version) => [version.name, ...version.trainedWords])
    .filter(Boolean)
    .join('\n');
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
