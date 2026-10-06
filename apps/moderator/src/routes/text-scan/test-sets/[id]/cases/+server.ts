import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { dbRead } from '$lib/server/db';
import { getModeratorDb } from '$lib/server/moderator-db';
import { purgeDeletedSources } from '$lib/server/text-scan-lab/purge.service';
import { getSet, listCases } from '$lib/server/text-scan-lab/test-sets.service';
import { casePreview } from '$lib/text-scan-lab/case-view';
import type { Expected, LabEntityType } from '$lib/text-scan-lab/types';

export type CaseListItem = {
  id: number;
  entityType: LabEntityType;
  entityId: number | null;
  /** Null once the case's text was wiped with its source. */
  preview: string | null;
  expected: Expected;
};

/** The Check page's case picker. Gated, like the set page, by the test-sets page grant. */
export const GET: RequestHandler = async ({ params }) => {
  const setId = Number(params.id);
  const set = Number.isSafeInteger(setId) && setId > 0 ? await getSet(setId) : null;
  if (!set) return json({ error: 'No such test set.' }, { status: 404 });
  await purgeDeletedSources({ moderator: getModeratorDb(), main: dbRead }, set.id);
  const cases: CaseListItem[] = (await listCases(set.id)).map((c) => ({
    id: c.id,
    entityType: c.entityType,
    entityId: c.entityId,
    preview: casePreview(c.fields),
    expected: c.expected,
  }));
  return json({ cases });
};
