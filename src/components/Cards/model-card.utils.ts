import type { BaseModel } from '~/shared/constants/basemodel.constants';

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
