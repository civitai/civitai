import { dbWrite } from '~/server/db/client';
import { registerTextScanProfile } from '~/server/services/text-scan/profiles';
import { loadModelScanSubjects } from '~/server/services/text-scan/profiles/model.profile';
import type { TextScanSubject } from '~/server/services/text-scan/types';

/**
 * The pre-publish gate's real-person scan (services/pre-publish-gate): a model that is not public
 * yet, with every version and its tags. Its verdict is only read by the gate; no adapter acts on it.
 */
export async function loadModelPrePublishSubjects(ids: number[]) {
  const [models, tags] = await Promise.all([
    loadModelScanSubjects(ids),
    dbWrite.tagsOnModels.findMany({
      where: { modelId: { in: ids } },
      select: { modelId: true, tag: { select: { name: true } } },
    }),
  ]);
  const tagsByModel = new Map<number, string[]>();
  for (const { modelId, tag } of tags)
    tagsByModel.set(modelId, [...(tagsByModel.get(modelId) ?? []), tag.name]);
  const subjects = new Map<number, TextScanSubject>();
  for (const [id, { notPublic: _, ...subject }] of models) {
    const names = tagsByModel.get(id);
    subjects.set(id, {
      ...subject,
      fields: [
        ...subject.fields,
        ...(names?.length ? [{ heading: 'Tags', text: names.join(', ') }] : []),
      ],
    });
  }
  return subjects;
}

registerTextScanProfile({
  entityType: 'ModelPrePublish',
  labels: ['poi'],
  load: loadModelPrePublishSubjects,
});
