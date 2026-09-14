import { constants } from '~/server/common/constants';
import type { BaseModel } from '~/shared/constants/basemodel.constants';
import { aDayAgo } from '~/utils/date-helpers';

type CardBaseModelData = {
  baseModels?: BaseModel[] | null;
  versions?: { baseModel?: BaseModel | null }[] | null;
  version?: { baseModel?: BaseModel | null } | null;
};

export function getCardBaseModels(
  data: CardBaseModelData,
  activeBaseModels?: string[]
): BaseModel[] {
  const source =
    data.baseModels ??
    data.versions?.map((v) => v.baseModel) ??
    (data.version?.baseModel ? [data.version.baseModel] : []);

  const distinct: BaseModel[] = [];
  for (const bm of source) {
    if (bm && !distinct.includes(bm)) distinct.push(bm);
  }

  if (!activeBaseModels?.length || distinct.length < 2) return distinct;

  const matched = distinct.filter((bm) => activeBaseModels.includes(bm));
  const rest = distinct.filter((bm) => !activeBaseModels.includes(bm));
  return [...matched, ...rest];
}

type CardRecencyData = {
  publishedAt?: Date | null;
  lastVersionAt?: Date | null;
};

export type ModelRecency = { isNew: boolean; isUpdated: boolean };

/**
 * The New/Updated rule for every model card surface. Three cards each restated it, and when the paid
 * badge was added to one of them (#4678) only that copy learned about it — a model then read "Paid"
 * on the feed and "New" in the resource picker at the same moment.
 *
 * `cutoff` defaults to the shared `aDayAgo` so the call sites keep the exact cutoff they already had,
 * including the one that had grown its own module-scope copy.
 */
export function getModelRecency(
  { publishedAt, lastVersionAt }: CardRecencyData,
  cutoff: Date = aDayAgo
): ModelRecency {
  return {
    isNew: !!publishedAt && publishedAt > cutoff,
    isUpdated:
      !!lastVersionAt &&
      !!publishedAt &&
      lastVersionAt > cutoff &&
      lastVersionAt.getTime() - publishedAt.getTime() > constants.timeCutOffs.updatedModel,
  };
}
